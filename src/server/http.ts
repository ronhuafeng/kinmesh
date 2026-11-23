import Fastify, { LogController } from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { constants } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { SESSION_LIFETIME_MS } from '../domain/contracts.js';
import type { Config } from './config.js';
import { limitKey, unlimited } from './limits.js';
import type { createMetrics } from './metrics.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    /** The server-side session's token; the cookie carries nothing else. */
    session: string;
  }
}
/**
 * The hub's HTTP server: what it logs, whom it trusts as a proxy, its
 * sealed session cookie, its rate limit and compression.
 */
export async function createHttp(
  config: Config,
  metrics: ReturnType<typeof createMetrics>,
  /** Where the log goes; standard output when absent. */
  logStream?: NodeJS.WritableStream,
) {
  const app = Fastify({
    // Only failures are logged, each with its request's ID; a request itself
    // is never logged, so its URL, headers and body never reach the log.
    logger: {
      level: 'info',
      ...(logStream ? { stream: logStream } : {}),
    },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    bodyLimit: 16_384,
    // Only the configured proxies may say who the client is; limits then
    // apply per client rather than to everyone behind the proxy at once.
    trustProxy:
      config.trustedProxies.length > 0 ? config.trustedProxies : false,
  });
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
  return app;
}
