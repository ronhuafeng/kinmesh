import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import type { Store } from '../persistence/store.js';
import { FeishuFailure, type Feishu } from './feishu.js';
import { principal } from './principals.js';

const Id = z.strictObject({ id: z.string().regex(/^[\w-]{16}$/) });
/**
 * What a person's own settings read and do about themselves: their profile
 * as Feishu gives it, their sessions, the browsers notifying them, and a
 * message from the team's Feishu bot to see that it reaches them.
 */
export function registerMe(
  app: FastifyInstance,
  store: Store,
  origin: string,
  feishu: Feishu,
) {
  const human = (request: FastifyRequest) => {
    const p = principal(request);
    if (p.kind !== 'human') throw new DomainError('forbidden');
    return p.humanId;
  };
  app.get('/api/me/profile', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const humanId = human(request);
    const [profile, team] = await Promise.all([
      store.sessions.profile(humanId),
      store.teamFor(humanId),
    ]);
    if (!profile || !team) throw new DomainError('forbidden');
    return { ...profile, team: team.team.name };
  });
  app.get('/api/me/sessions', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return store.sessions.list(
      human(request),
      request.session.get('session'),
      Date.now(),
    );
  });
  app.post('/api/me/session/end', async (request, reply) => {
    const ended = await store.sessions.end(
      human(request),
      Id.parse(request.body).id,
      Date.now(),
    );
    return reply.code(ended ? 204 : 404).send();
  });
  app.get('/api/push/browsers', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return store.browsers.browserList(human(request));
  });
  app.post('/api/push/forget', async (request, reply) => {
    const forgotten = await store.browsers.forgetBrowser(
      human(request),
      Id.parse(request.body).id,
    );
    return reply.code(forgotten ? 204 : 404).send();
  });
  // The team's bot sends the person one message: 204 when Feishu took it,
  // 502 when it refused (no bot, no permission) or couldn't be reached.
  app.post('/api/feishu/test', async (request, reply) => {
    const humanId = human(request);
    const union = await store.notifications.unionOf(humanId);
    if (union === null) return reply.code(409).send();
    const sent = await feishu
      .message(union, {
        title: 'Kinmesh',
        text: '飞书机器人能把通知送到你这里。',
        url: new URL('/?settings=connections', origin).href,
      })
      .then(
        () => true,
        (error: unknown) => {
          app.log.error(
            { error: error instanceof FeishuFailure ? error.message : 'Error' },
            'feishu_test_failed',
          );
          return false;
        },
      );
    return reply.code(sent ? 204 : 502).send();
  });
}
