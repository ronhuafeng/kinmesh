import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentId, TeamId } from '../domain/contracts.js';
import {
  CorrelationInput,
  GrantInput,
  IdentityError,
  ProfileInput,
  RuntimeEventInput,
  type Principal,
} from '../domain/agents.js';
import type { Store } from '../persistence/store.js';
import { removeAgentToken, writeAgentToken } from '../inbox/managed.js';
import { WORKER_GRANT } from './connect.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
function principal(request: FastifyRequest) {
  if (request.principal === null) throw new IdentityError(401);
  return request.principal;
}
const TeamPath = z.object({ teamId: TeamId });
const AgentPath = TeamPath.extend({ agentId: AgentId });
const GrantPath = AgentPath.extend({ grantId: z.uuid() });
const ExecutionPath = AgentPath.extend({ executionId: z.uuid() });
/** `directory` holds the tokens of agents connected from the workspace (ADR 0007). */
export function registerAgents(
  app: FastifyInstance,
  store: Store,
  directory: string,
) {
  const base = '/api/teams/:teamId/agents';
  app.post(base, (request, reply) => {
    const { teamId } = TeamPath.parse(request.params);
    return reply
      .code(201)
      .send(
        store.agents.create(
          principal(request),
          teamId,
          ProfileInput.parse(request.body),
        ),
      );
  });
  app.get(base, (request) =>
    store.agents.list(
      principal(request),
      TeamPath.parse(request.params).teamId,
    ),
  );
  app.get(base + '/:agentId', (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return store.agents.get(principal(request), teamId, agentId);
  });
  app.put(base + '/:agentId', (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return store.agents.update(
      principal(request),
      teamId,
      agentId,
      ProfileInput.parse(request.body),
    );
  });
  app.post(base + '/:agentId/lifecycle', (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    const { lifecycle } = z
      .strictObject({ lifecycle: z.enum(['active', 'disabled']) })
      .parse(request.body);
    const p = principal(request);
    const agent = store.agents.lifecycle(p, teamId, agentId, lifecycle);
    // Disabling revoked every credential; re-enabling a connected agent
    // gives its worker a fresh one so it can be woken again.
    const managed =
      lifecycle === 'active' ? store.managed.binding(p, teamId, agentId) : null;
    if (managed === null || agent.preferences.modelId === null) return agent;
    const { token } = store.managed.connect(
      p,
      teamId,
      agentId,
      { providerId: managed.providerId, modelId: agent.preferences.modelId },
      WORKER_GRANT,
    );
    writeAgentToken(directory, agentId, token);
    return store.agents.get(p, teamId, agentId);
  });
  app.get(base + '/:agentId/grants', (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return store.agents.grants(principal(request), teamId, agentId);
  });
  app.post(base + '/:agentId/grants', (request, reply) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return reply
      .header('Cache-Control', 'no-store')
      .code(201)
      .send(
        store.agents.issue(
          principal(request),
          teamId,
          agentId,
          GrantInput.parse(request.body),
        ),
      );
  });
  app.post(base + '/:agentId/grants/:grantId/revoke', (request, reply) => {
    const { teamId, agentId, grantId } = GrantPath.parse(request.params);
    store.agents.revoke(principal(request), teamId, agentId, grantId);
    // Revoking the managed worker credential disconnects the agent.
    if (store.managed.forgetGrant(teamId, agentId, grantId))
      removeAgentToken(directory, agentId);
    return reply.code(204).send();
  });
  app.post(base + '/:agentId/grants/:grantId/rotate', (request, reply) => {
    const { teamId, agentId, grantId } = GrantPath.parse(request.params);
    // The hub rotates its own worker credential by reconnecting; a rotated
    // token shown in the browser would never reach the worker.
    if (
      store.managed.binding(principal(request), teamId, agentId)?.grantId ===
      grantId
    )
      throw new IdentityError(409);
    return reply
      .header('Cache-Control', 'no-store')
      .code(201)
      .send(
        store.agents.rotate(
          principal(request),
          teamId,
          agentId,
          grantId,
          GrantInput.parse(request.body),
        ),
      );
  });
  app.get(base + '/:agentId/audit', (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return store.agents.audit(principal(request), teamId, agentId);
  });
  app.post(base + '/:agentId/executions', (request, reply) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return reply
      .code(201)
      .send(
        store.agents.correlate(
          principal(request),
          teamId,
          agentId,
          CorrelationInput.parse(request.body),
        ),
      );
  });
  app.get(base + '/:agentId/executions', (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return store.agents.correlations(principal(request), teamId, agentId);
  });
  app.post(
    base + '/:agentId/executions/:executionId/events',
    (request, reply) => {
      const { teamId, agentId, executionId } = ExecutionPath.parse(
        request.params,
      );
      return reply
        .code(201)
        .send(
          store.agents.runtimeEvent(
            principal(request),
            teamId,
            agentId,
            executionId,
            RuntimeEventInput.parse(request.body).state,
          ),
        );
    },
  );
  app.get(base + '/:agentId/executions/:executionId/events', (request) => {
    const { teamId, agentId, executionId } = ExecutionPath.parse(
      request.params,
    );
    return store.agents.runtimeEvents(
      principal(request),
      teamId,
      agentId,
      executionId,
    );
  });
}
