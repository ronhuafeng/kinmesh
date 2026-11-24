import { type Hub, TEAM_MCP_GRANT, WORKER_GRANT } from './connect.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentId, TeamId } from '../domain/contracts.js';
import { removeAgentToken, writeAgentToken } from '../runtime/managed.js';
import type { Store } from '../persistence/store.js';
import type { CodexHomes } from '../adapters/space/client.js';
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
  /**
   * Agents' Codex homes beside T3 and the Team MCP they reach; null without
   * a provisioner there, or without Team MCP.
   */
  codex: { homes: CodexHomes; url: string } | null = null,
) {
  /** Where the agent's Codex home is beside T3, for its T3 provider. */
  app.get(
    '/api/teams/:teamId/agents/:agentId/codex',
    async (request, reply) => {
      const p = principal(request);
      const { teamId, agentId } = AgentPath.parse(request.params);
      await store.agents.get(p, teamId, agentId);
      if (p.kind !== 'human')
        return reply.code(403).send({ error: 'forbidden' });
      if (codex === null)
        return reply.code(409).send({ error: 'No Codex homes' });
      try {
        return {
          home: await codex.homes.home(agentId, AbortSignal.timeout(10_000)),
        };
      } catch {
        return reply.code(503).send({ error: 'Provisioner unavailable' });
      }
    },
  );
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
      // Its Codex home gets a new Team MCP credential, which replaces the
      // one there only once it is written.
      if (codex !== null) {
        const teamMcp = await store.managed.issueTeamMcp(
          p,
          teamId,
          agentId,
          TEAM_MCP_GRANT,
        );
        try {
          await codex.homes.write(
            agentId,
            { url: codex.url, token: teamMcp.token },
            AbortSignal.timeout(30_000),
          );
        } catch {
          await store.agents.revoke(p, teamId, agentId, teamMcp.grant.id);
          return reply
            .code(503)
            .send({ error: 'Connected; its Codex home was not written' });
        }
        await store.managed.keepTeamMcp(p, teamId, agentId, teamMcp.grant.id);
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
