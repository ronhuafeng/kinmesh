import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';

/** Team MCP's HTTP server: small bodies, short timeouts, few connections, a rate limit. */
export async function createTeamHttp() {
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    requestTimeout: 10000,
    connectionTimeout: 10000,
    forceCloseConnections: true,
  });
  app.server.maxConnections = 128;
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  return app;
}
