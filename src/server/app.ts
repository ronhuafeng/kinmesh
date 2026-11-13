import { registerWorkspace } from './workspace.js';
import { registerEvents } from './events.js';
import { watchChanges } from './changes.js';
import { registerWeb } from './web.js';
import { registerTasks } from './tasks.js';
import { registerCommunication } from './communication.js';
import { registerAgents } from './agents.js';
import { defaultHub, registerConnect, type Hub } from './connect.js';
import { managedDirectory, t3AuthFile } from '../inbox/managed.js';
import { credentialMark, resolvePrincipal } from './principals.js';
import { IdentityError } from '../domain/agents.js';
import { z } from 'zod';
import Fastify from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import { hash, verify } from '@node-rs/argon2';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BootstrapInput, Credentials, HumanId } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import type { Config } from './config.js';

/** One KDF cost for every password hash, including the unknown-account dummy. */
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
declare module '@fastify/secure-session' {
  interface SessionData {
    humanId: string;
    /** Mark of the password this session signed in with. */
    credential: string;
  }
}
export async function createApp(
  config: Config,
  store: Store,
  workerReady: () => boolean = () => true,
  beforeClose?: () => Promise<void>,
  overrides: Partial<Omit<Hub, 'directory'>> = {},
) {
  const hub = {
    ...defaultHub(managedDirectory(config.database)),
    ...overrides,
  };
  const app = Fastify({ logger: false, bodyLimit: 16_384, trustProxy: false });
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
  await app.register(secureSession, {
    key: config.sessionKey,
    cookieName: 'kinmesh-session',
    expiry: 3600,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookie,
      maxAge: 3600,
    },
  });
  // A dummy hash makes unknown-account verification perform the same expensive KDF.
  const dummyHash = await hash('unusable random account password', ARGON2);
  app.decorateRequest('principal', null);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return void reply.code(400).send({ error: 'Invalid input' });
    const known = z
      .object({ statusCode: z.number().int().min(400).max(499) })
      .safeParse(error);
    const status = known.success ? known.data.statusCode : 500;
    void reply.code(status).send({
      error:
        status === 429
          ? 'Too many requests'
          : status < 500
            ? 'Request rejected'
            : 'Internal service error',
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (
      ['x-actor-id', 'x-member-id', 'x-user-id', 'x-kinmesh-actor'].some(
        (header) => request.headers[header] !== undefined,
      )
    ) {
      return reply
        .code(400)
        .send({ error: 'Actor headers are not credentials' });
    }
    if (
      [...new URL(request.url, config.origin).searchParams.keys()].some((key) =>
        ['actor', 'actorid', 'agentid', 'humanid', 'role'].includes(
          key.toLowerCase(),
        ),
      )
    )
      return reply.code(400).send({ error: 'Actor query is not a credential' });
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      request.headers.origin !== undefined &&
      request.headers.origin !== config.origin
    ) {
      return reply.code(403).send({ error: 'Origin denied' });
    }
  });
  app.get('/health', (_request, reply) => {
    const ready = store.ready() && workerReady();
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'unavailable',
      component: 'kinmesh-team-hub',
    });
  });
  // Whether first-owner setup is still possible, so the sign-in page offers
  // it only then. Reveals nothing else.
  app.get('/api/setup/status', (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send({ open: !store.isBootstrapped() }),
  );
  app.post(
    '/api/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const supplied = request.headers.authorization;
      const expected = createHash('sha256')
        .update(`Bearer ${config.setupToken}`)
        .digest();
      const actual = createHash('sha256')
        .update(typeof supplied === 'string' ? supplied : '')
        .digest();
      if (!timingSafeEqual(expected, actual))
        return reply.code(401).send({ error: 'Setup authorization required' });
      if (store.isBootstrapped())
        return reply.code(409).send({ error: 'Setup already completed' });
      const input = BootstrapInput.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send({ error: 'Invalid setup input' });
      const passwordHash = await hash(input.data.password, ARGON2);
      try {
        const result = store.bootstrap(
          input.data.username,
          passwordHash,
          input.data.teamName,
        );
        return await reply.code(201).send(result);
      } catch (error) {
        if (store.isBootstrapped())
          return await reply
            .code(409)
            .send({ error: 'Setup already completed' });
        throw error;
      }
    },
  );
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = Credentials.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: 'Invalid login input' });
      const account = store.credentials(parsed.data.username);
      const valid = await verify(
        account?.passwordHash ?? dummyHash,
        parsed.data.password,
      );
      if (!valid || account === undefined)
        return reply.code(401).send({ error: 'Invalid credentials' });
      request.session.regenerate();
      request.session.set('humanId', account.id);
      request.session.set('credential', credentialMark(account.passwordHash));
      return { authenticated: true };
    },
  );
  // Change your own password. Every other session ends; this one continues.
  app.post(
    '/api/me/password',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const principal = request.principal;
      if (principal?.kind !== 'human') throw new IdentityError(403);
      const input = z
        .strictObject({
          currentPassword: Credentials.shape.password,
          newPassword: Credentials.shape.password,
        })
        .safeParse(request.body);
      if (!input.success)
        return reply.code(400).send({ error: 'Invalid password input' });
      const current = store.passwordHash(principal.humanId);
      if (
        current === undefined ||
        !(await verify(current, input.data.currentPassword))
      )
        return reply.code(403).send({ error: 'Current password is wrong' });
      const next = await hash(input.data.newPassword, ARGON2);
      store.setPasswordHash(principal.humanId, next);
      request.session.regenerate();
      request.session.set('humanId', principal.humanId);
      request.session.set('credential', credentialMark(next));
      return reply.code(204).send();
    },
  );
  app.post('/api/logout', (request, reply) => {
    request.session.delete();
    return reply.code(204).send();
  });
  app.addHook('preHandler', async (request, reply) => {
    if (
      !request.url.startsWith('/api/') ||
      ['/api/setup', '/api/setup/status', '/api/login'].includes(
        request.routeOptions.url ?? '',
      )
    )
      return;
    request.principal = resolvePrincipal(
      store,
      request.headers.authorization,
      request.session.get('humanId'),
      request.session.get('credential'),
    );
    if (
      !request.url.startsWith('/api/teams/') &&
      request.principal.kind !== 'human'
    )
      return reply.code(403).send({ error: 'Human authentication required' });
  });
  const changes = watchChanges(store);
  registerAgents(app, store, hub.directory);
  const { t3Status } = registerConnect(app, store, hub, changes);
  registerCommunication(app, store);
  registerTasks(app, store);
  const { snapshot, runs } = registerWorkspace(
    app,
    store,
    t3AuthFile(hub.directory),
  );
  registerEvents(app, store, changes, { snapshot, t3Status, runs });
  await registerWeb(app);
  await app.register((protectedApi, _options, done) => {
    protectedApi.get('/api/me', (request) => {
      const id = HumanId.parse(request.session.get('humanId'));
      return { human: store.human(id) };
    });
    protectedApi.get('/api/team', (request, reply) => {
      const team = store.teamFor(HumanId.parse(request.session.get('humanId')));
      return team ?? reply.code(403).send({ error: 'Membership required' });
    });
    // The owner renames the team; the name is what everyone sees.
    protectedApi.put('/api/team', (request) => {
      const id = HumanId.parse(request.session.get('humanId'));
      const { name } = z
        .strictObject({ name: BootstrapInput.shape.teamName })
        .parse(request.body);
      return store.renameTeam(id, name);
    });
    done();
  });
  if (beforeClose) app.addHook('preClose', beforeClose);
  app.addHook('onClose', () => {
    changes.close();
    store.close();
  });
  await app.ready();
  return app;
}
