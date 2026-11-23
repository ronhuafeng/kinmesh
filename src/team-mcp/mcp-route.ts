import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Store } from '../persistence/store.js';
import type { AttachmentStore } from '../persistence/attachment-store.js';
import type { TeamConfig } from './config.js';
import { teamServer } from './tools.js';

/**
 * The MCP endpoint: each POST gets its own server for its caller, at most
 * `concurrency` at once; other methods are refused.
 */
export function registerMcp(
  app: FastifyInstance,
  store: Store,
  config: TeamConfig,
  files: AttachmentStore,
) {
  let active = 0;
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
      const server = teamServer(store, authorization, files);
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
}
