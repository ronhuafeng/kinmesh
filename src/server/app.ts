import { registerWorkspace } from './workspace.js';
import { registerEvents } from './events.js';
import { watchChanges } from './changes.js';
import { registerWeb } from './web.js';
import { registerTasks } from './tasks.js';
import { registerCommunication } from './communication.js';
import { registerAgents } from './agents.js';
import { defaultHub, registerConnect, type Hub } from './connect.js';
import { managedDirectory, t3AuthFile } from '../inbox/managed.js';
import { principal, resolvePrincipal } from './principals.js';
import { IdentityError } from '../domain/agents.js';
import { z } from 'zod';
import Fastify, { type FastifyRequest } from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { SESSION_LIFETIME_MS } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import type { Config } from './config.js';
import { describeFailure } from '../diagnostics.js';
import { feishuClient, type Feishu } from './feishu.js';
import { registerLogin } from './login.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    /** The server-side session's token; the cookie carries nothing else. */
    session: string;
  }
}
export async function createApp(
  config: Config,
  store: Store,
  workerReady: () => boolean = () => true,
  beforeClose?: () => Promise<void>,
  overrides: Partial<Omit<Hub, 'directory'>> = {},
  options: {
    /** Where the log goes; standard output when absent. */
    logStream?: NodeJS.WritableStream;
    /** Feishu itself unless a test stands in for it. */
    feishu?: Feishu;
  } = {},
) {
  const hub = {
    ...defaultHub(managedDirectory(config.database)),
    ...overrides,
  };
  const app = Fastify({
    // Only failures are logged, each with its request's ID; a request itself
    // is never logged, so its URL, headers and body never reach the log.
    logger: {
      level: 'info',
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    bodyLimit: 16_384,
    // Only the configured proxies may say who the client is; limits then
    // apply per client rather than to everyone behind the proxy at once.
    trustProxy:
      config.trustedProxies.length > 0 ? config.trustedProxies : false,
  });
  await app.register(rateLimit, {
    max: config.rateLimit,
    timeWindow: '1 minute',
  });
  await app.register(secureSession, {
    key: config.sessionKey,
    cookieName: 'kinmesh-session',
    // The server ends a session (idle, lifetime, revoked); the cookie only
    // has to outlive it.
    expiry: SESSION_LIFETIME_MS / 1000,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookie,
      maxAge: SESSION_LIFETIME_MS / 1000,
    },
  });
  app.decorateRequest('principal', null);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return void reply.code(400).send({ error: 'Invalid input' });
    const known = z
      .object({ statusCode: z.number().int().min(400).max(499) })
      .safeParse(error);
    const status = known.success ? known.data.statusCode : 500;
    // A failure is recorded; a refusal only when a constraint caused it.
    const where = {
      route: request.routeOptions.url,
      method: request.method,
      status,
    };
    if (status >= 500)
      request.log.error({ ...where, ...describeFailure(error) }, 'failed');
    else if (error instanceof Error && error.cause !== undefined)
      request.log.warn(
        { ...where, ...describeFailure(error.cause) },
        'refused',
      );
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
  registerLogin(
    app,
    store,
    config,
    options.feishu ?? feishuClient(config.feishu),
  );
  app.post('/api/logout', (request, reply) => {
    store.sessions.revoke(request.session.get('session'), Date.now());
    request.session.delete();
    return reply.code(204).send();
  });
  // Sign out everywhere: every session of yours ends, this one included.
  app.post('/api/me/sessions/end', (request, reply) => {
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new IdentityError(403);
    store.sessions.revokeAll(principal.humanId, Date.now());
    request.session.delete();
    return reply.code(204).send();
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    request.principal = resolvePrincipal(
      store,
      request.headers.authorization,
      request.session.get('session'),
    );
    if (
      !request.url.startsWith('/api/teams/') &&
      request.principal.kind !== 'human'
    )
      return reply.code(403).send({ error: 'Human authentication required' });
  });
  const changes = watchChanges(store);
  const { grants } = registerAgents(app, store, hub.directory);
  const { t3Status } = registerConnect(app, store, hub, changes);
  registerCommunication(app, store);
  registerTasks(app, store);
  const { snapshot, runs } = registerWorkspace(
    app,
    store,
    t3AuthFile(hub.directory),
  );
  registerEvents(app, store, changes, { snapshot, t3Status, runs, grants });
  await registerWeb(app);
  // The person behind the request; the pre-handler resolved their session.
  const human = (request: FastifyRequest) => {
    const p = principal(request);
    if (p.kind !== 'human') throw new IdentityError(403);
    return p.humanId;
  };
  await app.register((protectedApi, _options, done) => {
    protectedApi.get('/api/me', (request) => ({
      human: store.human(human(request)),
    }));
    protectedApi.get('/api/team', (request, reply) => {
      const team = store.teamFor(human(request));
      return team ?? reply.code(403).send({ error: 'Membership required' });
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
