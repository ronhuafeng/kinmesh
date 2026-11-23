import { type Hub, WORKER_GRANT } from './connect.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentId, TeamId } from '../domain/contracts.js';
import { removeAgentToken, writeAgentToken } from '../runtime/managed.js';
import type { Store } from '../persistence/store.js';
import { principal } from './principals.js';

const TeamPath = z.object({ teamId: TeamId });
const AgentPath = TeamPath.extend({ agentId: AgentId });
/**
 * An agent connected from the workspace to the worker the hub supervises,
 * with a credential the hub keeps for it, and disconnected again.
 */
export function registerAgentWorkers(
  app: FastifyInstance,
  store: Store,
  hub: Hub,
) {
  app.post(
    '/api/teams/:teamId/agents/:agentId/connect',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = principal(request);
      const { teamId, agentId } = AgentPath.parse(request.params);
      const choice = z
        .strictObject({
          providerId: z.string().trim().min(1).max(256),
          modelId: z.string().trim().min(1).max(256),
        })
        .parse(request.body);
      const issued = await store.managed.connect(
        p,
        teamId,
        agentId,
        choice,
        WORKER_GRANT,
      );
      if (issued !== null)
        try {
          writeAgentToken(hub.directory, agentId, issued.token);
        } catch {
          await store.managed.disconnect(p, teamId, agentId);
          return reply.code(500).send({ error: 'Could not store credential' });
        }
      try {
        await hub.ensureWorker();
      } catch {
        return reply
          .code(503)
          .send({ error: 'Connected; the worker will start with the hub' });
      }
      return { connected: true };
    },
  );
  app.post(
    '/api/teams/:teamId/agents/:agentId/disconnect',
    async (request, reply) => {
      const { teamId, agentId } = AgentPath.parse(request.params);
      await store.managed.disconnect(principal(request), teamId, agentId);
      removeAgentToken(hub.directory, agentId);
      return reply.code(204).send();
    },
  );
}
