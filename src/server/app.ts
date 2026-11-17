import { registerWorkspace } from './workspace.js';
import { registerEvents } from './events.js';
import { watchChanges } from './changes.js';
import { registerWeb } from './web.js';
import { registerTasks } from './tasks.js';
import { registerCommunication } from './communication.js';
import { registerNotifications } from './notify.js';
import { registerMe } from './me.js';
import { registerAgents } from './agents.js';
import {
  WORKER_GRANT,
  defaultHub,
  registerConnect,
  type Hub,
} from './connect.js';
import {
  endProvisionedT3,
  provisionedT3,
  separateDeploymentSession,
} from './provision.js';
import { managedDirectory } from '../inbox/managed.js';
import { principal, resolvePrincipal } from './principals.js';
import { DomainError, type Refusal } from '../domain/errors.js';
import { z } from 'zod';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { constants } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { SESSION_LIFETIME_MS } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import type { Config } from './config.js';
import { describeFailure } from '../diagnostics.js';
import { feishuClient, type Feishu } from './feishu.js';
import { registerLogin } from './login.js';
import { limitKey, unlimited } from './limits.js';
import { createMetrics } from './metrics.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    /** The server-side session's token; the cookie carries nothing else. */
    session: string;
  }
}
/** The HTTP status of each refusal; every route answers with these. */
const STATUS: Record<Refusal, 400 | 401 | 403 | 404 | 409> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
};
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
    ...defaultHub(
      managedDirectory(config.state),
      new URL(config.origin).protocol === 'https:',
      config.t3 !== null,
    ),
    ...overrides,
  };
  const app = Fastify({
    // Only failures are logged, each with its request's ID; a request itself
    // is never logged, so its URL, headers and body never reach the log.
    logger: {
      level: 'info',
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    bodyLimit: 16_384,
    // Only the configured proxies may say who the client is; limits then
    // apply per client rather than to everyone behind the proxy at once.
    trustProxy:
      config.trustedProxies.length > 0 ? config.trustedProxies : false,
  });
  const metrics = createMetrics();
  // The session is unsealed first: the limit counts a signed-in person by
  // their session, everyone else by address.
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
  await app.register(rateLimit, {
    max: config.rateLimit,
    timeWindow: '1 minute',
    keyGenerator: limitKey,
    allowList: unlimited,
    onExceeded: metrics.limited,
  });
  // Answers travel compressed, at a level quick enough for every read; the
  // web's own files are compressed once, when built (`registerWeb`). The
  // event stream writes its own response, and goes as it is, at once.
  await app.register(compress, {
    encodings: ['br', 'gzip'],
    brotliOptions: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
    zlibOptions: { level: 6 },
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
    // Fastify's own refusals (a body too large, a rate limit) carry theirs.
    const known = z
      .object({ statusCode: z.number().int().min(400).max(499) })
      .safeParse(error);
    const status =
      error instanceof DomainError
        ? STATUS[error.kind]
        : known.success
          ? known.data.statusCode
          : 500;
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
  // Liveness: the process answers. Readiness (below): it can do its work.
  // Both name the commit the hub runs, so a deployment can be checked.
  const version = config.version;
  app.get('/health/live', (_request, reply) =>
    reply.send({ status: 'ok', component: 'kinmesh-team-hub', version }),
  );
  // Ready: the database answers (it opens only fully migrated) and the
  // supervised Inbox worker, when there is one, is connected.
  app.get('/health', async (_request, reply) => {
    const ready = (await store.ready()) && workerReady();
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'unavailable',
      component: 'kinmesh-team-hub',
      version,
    });
  });
  const feishu = options.feishu ?? feishuClient(config.feishu);
  registerLogin(app, store, config, feishu);
  app.post('/api/logout', async (request, reply) => {
    await store.notifications.signedOut(request.session.get('session'));
    await store.sessions.revoke(request.session.get('session'), Date.now());
    request.session.delete();
    return reply.code(204).send();
  });
  // Sign out everywhere: every session of yours ends, this one included.
  app.post('/api/me/sessions/end', async (request, reply) => {
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new DomainError('forbidden');
    await store.notifications.signedOutEverywhere(principal.humanId);
    await store.sessions.revokeAll(principal.humanId, Date.now());
    request.session.delete();
    return reply.code(204).send();
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    request.principal = await resolvePrincipal(
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
  const { t3Status, renewal, runCredential } = registerConnect(
    app,
    store,
    hub,
    changes,
  );
  try {
    separateDeploymentSession(hub.directory);
  } catch (error) {
    app.log.error(describeFailure(error), 't3_session_separation_failed');
  }
  // The deployment's T3: applied now, then whenever its session is renewed.
  let provisioning: NodeJS.Timeout | undefined;
  if (config.t3) {
    const sync = provisionedT3(
      store,
      hub.directory,
      config.t3,
      fetch,
      hub.ceiling,
    );
    const run = () => {
      sync().then(
        (changed) => {
          if (changed) changes.emit();
        },
        (error: unknown) => {
          app.log.error(
            { error: error instanceof Error ? error.name : 'Error' },
            't3_provision_failed',
          );
        },
      );
    };
    run();
    provisioning = setInterval(run, 60_000);
    provisioning.unref();
  } else
    try {
      // Only a person's sign-in runs now; the deployment's is not renewed.
      endProvisionedT3(hub.directory);
    } catch (error) {
      app.log.error(describeFailure(error), 't3_provision_end_failed');
    }
  // The hub's own worker credentials never run out while it serves their
  // agents: renewed now, before anything is served, then every hour.
  const renew = () =>
    store.managed
      .renewWorkerGrants(WORKER_GRANT.lifetimeSeconds)
      .catch((error: unknown) => {
        app.log.error(describeFailure(error), 'worker_grant_renewal_failed');
      });
  await renew();
  const renewing = setInterval(() => void renew(), 3_600_000);
  renewing.unref();
  // Work that never reached T3 expires on time, also for an agent no worker
  // serves: no claim ever looks at its work.
  const expire = () =>
    store.inbox.expire().catch((error: unknown) => {
      app.log.error(describeFailure(error), 'inbox_expiry_failed');
    });
  await expire();
  const expiring = setInterval(() => void expire(), 60_000);
  expiring.unref();
  registerCommunication(app, store);
  registerTasks(app, store);
  registerNotifications(app, store, config.origin, hub.directory, feishu);
  registerMe(app, store, config.origin, feishu);
  const { snapshot, runs } = registerWorkspace(
    app,
    store,
    runCredential,
    renewal,
    changes,
    metrics.workspaceRead,
  );
  const { openStreams } = registerEvents(app, store, changes, {
    snapshot,
    t3Status,
    runs,
    grants,
  });
  metrics.register(app, store, config.metricsToken, {
    workerReady,
    openStreams,
  });
  await registerWeb(app);
  // The person behind the request; the pre-handler resolved their session.
  const human = (request: FastifyRequest) => {
    const p = principal(request);
    if (p.kind !== 'human') throw new DomainError('forbidden');
    return p.humanId;
  };
  await app.register((protectedApi, _options, done) => {
    protectedApi.get('/api/me', async (request) => ({
      human: await store.human(human(request)),
    }));
    protectedApi.get('/api/team', async (request, reply) => {
      const team = await store.teamFor(human(request));
      return team ?? reply.code(403).send({ error: 'Membership required' });
    });
    done();
  });
  if (beforeClose) app.addHook('preClose', beforeClose);
  app.addHook('onClose', async () => {
    clearInterval(provisioning);
    clearInterval(renewing);
    clearInterval(expiring);
    changes.close();
    await store.close();
  });
  await app.ready();
  return app;
}
