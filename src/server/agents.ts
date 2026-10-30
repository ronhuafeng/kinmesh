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
export function registerAgents(app: FastifyInstance, store: Store) {
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
    return store.agents.lifecycle(
      principal(request),
      teamId,
      agentId,
      lifecycle,
    );
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
    return reply.code(204).send();
  });
  app.post(base + '/:agentId/grants/:grantId/rotate', (request, reply) => {
    const { teamId, agentId, grantId } = GrantPath.parse(request.params);
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
