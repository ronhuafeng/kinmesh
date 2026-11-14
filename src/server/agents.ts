import type { FastifyInstance } from 'fastify';
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
import { fingerprint } from '../persistence/transactional.js';
import { AVATAR_LIMIT } from '../persistence/agents.js';
import { removeAgentToken, writeAgentToken } from '../inbox/managed.js';
import { WORKER_GRANT } from './connect.js';
import { principal } from './principals.js';
const TeamPath = z.object({ teamId: TeamId });
const AgentPath = TeamPath.extend({ agentId: AgentId });
const GrantPath = AgentPath.extend({ grantId: z.uuid() });
const ExecutionPath = AgentPath.extend({ executionId: z.uuid() });
/** `directory` holds the tokens of agents connected from the workspace. */
export function registerAgents(
  app: FastifyInstance,
  store: Store,
  directory: string,
) {
  const base = '/api/teams/:teamId/agents';
  app.post(base, async (request, reply) => {
    const { teamId } = TeamPath.parse(request.params);
    return reply
      .code(201)
      .send(
        await store.agents.create(
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
  // An avatar travels as the image itself, never as JSON or a URL.
  app.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/webp'],
    { parseAs: 'buffer', bodyLimit: AVATAR_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.put(base + '/:agentId/avatar', { bodyLimit: AVATAR_LIMIT }, (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    if (!Buffer.isBuffer(request.body)) throw new IdentityError(400);
    return store.agents.setAvatar(
      principal(request),
      teamId,
      agentId,
      request.body,
    );
  });
  app.delete(base + '/:agentId/avatar', async (request, reply) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    await store.agents.removeAvatar(principal(request), teamId, agentId);
    return reply.code(204).send();
  });
  app.get(base + '/:agentId/avatar', async (request, reply) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    const image = await store.agents.avatar(
      principal(request),
      teamId,
      agentId,
    );
    if (image === null) throw new IdentityError(404);
    return reply
      .header('content-type', image.mime)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(image.bytes);
  });
  app.post(base + '/:agentId/lifecycle', async (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    const { lifecycle } = z
      .strictObject({ lifecycle: z.enum(['active', 'disabled']) })
      .parse(request.body);
    const p = principal(request);
    const agent = await store.agents.lifecycle(p, teamId, agentId, lifecycle);
    // Disabling revoked every credential; re-enabling a connected agent
    // gives its worker a fresh one so it can be woken again.
    const managed =
      lifecycle === 'active'
        ? await store.managed.binding(p, teamId, agentId)
        : null;
    if (managed === null || agent.preferences.modelId === null) return agent;
    const { token } = await store.managed.connect(
      p,
      teamId,
      agentId,
      { providerId: managed.providerId, modelId: agent.preferences.modelId },
      WORKER_GRANT,
    );
    writeAgentToken(directory, agentId, token);
    return store.agents.get(p, teamId, agentId);
  });
  /** An agent's credentials, never a hash or secret, and their revision. */
  const grants = async (
    caller: Principal,
    teamId: TeamId,
    agentId: AgentId,
  ) => {
    const listed = await store.agents.grants(caller, teamId, agentId);
    return { grants: listed, revision: fingerprint(listed) };
  };
  app.get(base + '/:agentId/grants', (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return grants(principal(request), teamId, agentId);
  });
  app.post(base + '/:agentId/grants', async (request, reply) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return reply
      .header('Cache-Control', 'no-store')
      .code(201)
      .send(
        await store.agents.issue(
          principal(request),
          teamId,
          agentId,
          GrantInput.parse(request.body),
        ),
      );
  });
  app.post(
    base + '/:agentId/grants/:grantId/revoke',
    async (request, reply) => {
      const { teamId, agentId, grantId } = GrantPath.parse(request.params);
      await store.agents.revoke(principal(request), teamId, agentId, grantId);
      // Revoking the managed worker credential disconnects the agent.
      if (await store.managed.forgetGrant(teamId, agentId, grantId))
        removeAgentToken(directory, agentId);
      return reply.code(204).send();
    },
  );
  app.post(
    base + '/:agentId/grants/:grantId/rotate',
    async (request, reply) => {
      const { teamId, agentId, grantId } = GrantPath.parse(request.params);
      // The hub rotates its own worker credential by reconnecting; a rotated
      // token shown in the browser would never reach the worker.
      if (
        (await store.managed.binding(principal(request), teamId, agentId))
          ?.grantId === grantId
      )
        throw new IdentityError(409);
      return reply
        .header('Cache-Control', 'no-store')
        .code(201)
        .send(
          await store.agents.rotate(
            principal(request),
            teamId,
            agentId,
            grantId,
            GrantInput.parse(request.body),
          ),
        );
    },
  );
  app.get(base + '/:agentId/audit', (request) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return store.agents.audit(principal(request), teamId, agentId);
  });
  app.post(base + '/:agentId/executions', async (request, reply) => {
    const { teamId, agentId } = AgentPath.parse(request.params);
    return reply
      .code(201)
      .send(
        await store.agents.correlate(
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
    async (request, reply) => {
      const { teamId, agentId, executionId } = ExecutionPath.parse(
        request.params,
      );
      return reply
        .code(201)
        .send(
          await store.agents.runtimeEvent(
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
  return { grants };
}
