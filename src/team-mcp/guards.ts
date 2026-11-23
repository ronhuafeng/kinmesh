import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import type { TeamConfig } from './config.js';
import { agentPrincipal } from './tools.js';

/**
 * Who may reach Team MCP: only its own hosts and origin, never with a
 * cookie or a claimed actor, only at /mcp, and only with an agent's bearer
 * credential, whose arrival is noted for the workspace.
 */
export function registerGuards(
  app: FastifyInstance,
  store: Store,
  config: TeamConfig,
) {
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
      await store.teamMcpPresence.seenByTeamMcp(agent);
    } catch {
      // Evidence only: a failed write never refuses an authenticated request.
    }
  });
}
