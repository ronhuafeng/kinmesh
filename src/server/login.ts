import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import type { Config } from './config.js';
import { LOGIN_STATE_MS } from '../domain/contracts.js';
import { describeFailure } from '../diagnostics.js';
import { organizationMember, type Feishu } from './feishu.js';

const STATE_COOKIE = 'kinmesh-login';
const Callback = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256),
});

/**
 * Sign-in through Feishu. A person is their Feishu identity, admitted by an
 * enterprise mailbox in the organization's domain; there is no other way in.
 */
export function registerLogin(
  app: FastifyInstance,
  store: Store,
  config: Config,
  feishu: Feishu,
) {
  const redirectUri = `${config.origin}/login/callback`;
  const limit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  // A link, not a form: the page's form-action policy keeps forms on-site.
  app.get('/login', limit, (_request, reply) => {
    const state = store.logins.begin(Date.now());
    // Lax, because Feishu sends the browser back from another site.
    void reply.setCookie(STATE_COOKIE, state, {
      path: '/login',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookie,
      maxAge: LOGIN_STATE_MS / 1000,
    });
    return reply
      .header('Cache-Control', 'no-store')
      .redirect(feishu.authorizeUrl(state, redirectUri));
  });
  app.get('/login/callback', limit, async (request, reply) => {
    const cookie = request.cookies[STATE_COOKIE];
    void reply.clearCookie(STATE_COOKIE, { path: '/login' });
    reply.header('Cache-Control', 'no-store');
    const turnBack = (reason: 'expired' | 'denied' | 'unavailable') =>
      reply.redirect(`/?signin=${reason}`);
    const query = Callback.safeParse(request.query);
    // The state proves this browser began this sign-in, once, recently.
    if (
      !query.success ||
      cookie !== query.data.state ||
      !store.logins.finish(query.data.state, Date.now())
    )
      return turnBack('expired');
    // No code: the person turned back at Feishu, and knows it.
    if (query.data.code === undefined) return reply.redirect('/');
    let member: ReturnType<typeof organizationMember>;
    try {
      const profile = await feishu.profile(
        await feishu.exchange(query.data.code, redirectUri),
      );
      member = organizationMember(profile, config.feishu.emailDomain);
    } catch (error) {
      request.log.warn(
        { route: '/login/callback', ...describeFailure(error) },
        'refused',
      );
      return turnBack('unavailable');
    }
    if (member === null) return turnBack('denied');
    const human = store.signIn(member);
    // The team is the organization: its name follows Feishu's. Without it,
    // the name stays as it was and the sign-in goes on.
    try {
      const name = (await feishu.organization()).trim().slice(0, 80);
      if (name !== '') store.renameTeam(human.id, name);
    } catch (error) {
      request.log.warn(
        { route: '/login/callback', ...describeFailure(error) },
        'failed',
      );
    }
    request.session.regenerate();
    request.session.set('session', store.sessions.open(human.id, Date.now()));
    return reply.redirect('/');
  });
}
