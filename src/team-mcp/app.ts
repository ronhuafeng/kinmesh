import Fastify from 'fastify';
import { z } from 'zod';
import rateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Store } from '../persistence/store.js';
import type { TeamConfig } from './config.js';
import { agentPrincipal, teamServer } from './tools.js';

export async function createTeamApp(config: TeamConfig, store: Store) {
  const app = Fastify({
    logger: false,
    bodyLimit: 16384,
    requestTimeout: 10000,
    connectionTimeout: 10000,
    forceCloseConnections: true,
  });
  app.server.maxConnections = 128;
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  let active = 0;
  app.setErrorHandler((_error, _request, reply) => {
    // Never echo SDK validation inputs, tokens, database or request diagnostics.
    const status = z.object({ statusCode: z.number() }).safeParse(_error);
    void reply
      .code(
        status.success && [400, 413, 429].includes(status.data.statusCode)
          ? status.data.statusCode
          : 500,
      )
      .send({ error: 'Request rejected' });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (
      !config.hosts.includes(request.headers.host ?? '') ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== config.origin)
    ) {
      return reply.code(403).send({ error: 'Request rejected' });
    }
    if (
      request.headers.cookie !== undefined ||
      Object.keys(request.headers).some((h) =>
        /^(?:x-kinmesh-actor|x-actor|x-kinmesh-member)(?:-|$)/.test(h),
      ) ||
      request.url !== '/mcp'
    ) {
      return reply.code(400).send({ error: 'Request rejected' });
    }
    let agent;
    try {
      agent = await agentPrincipal(store, request.headers.authorization);
    } catch {
      return reply
        .header('WWW-Authenticate', 'Bearer realm="kinmesh-team"')
        .code(401)
        .send({ error: 'Authentication required' });
    }
    try {
      // Evidence for the workspace that this agent's provider reaches Team MCP.
      await store.managed.seenByTeamMcp(agent);
    } catch {
      // Evidence only: a failed write never refuses an authenticated request.
    }
  });
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      if (request.method !== 'POST')
        return reply
          .header('Allow', 'POST')
          .code(405)
          .send({ error: 'Method not supported' });
      if (active >= config.concurrency)
        return reply.code(503).send({ error: 'Service busy' });
      const authorization = request.headers.authorization;
      if (authorization === undefined)
        return reply.code(401).send({ error: 'Authentication required' });
      reply.raw.setHeader('Cache-Control', 'no-store');
      reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
      const server = teamServer(store, authorization);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      active++;
      try {
        await server.connect(transport);
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end('{"error":"Operation failed"}');
        } else if (!reply.raw.writableEnded) reply.raw.end();
      } finally {
        try {
          await server.close();
        } finally {
          active--;
        }
      }
    },
  });
  app.addHook('onClose', async () => {
    await store.close();
  });
  await app.ready();
  return app;
}
