import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '@ag-ui/core';
import { AgentId, ChannelId, TeamId } from '../domain/contracts.js';
import { IdentityError } from '../domain/agents.js';
import { TopicId } from '../domain/communication.js';
import type { Store } from '../persistence/store.js';
import { WorkspaceSnapshot, executionEvent } from '../workspace/contracts.js';

const Query = z.strictObject({
  channelId: ChannelId.optional(),
  topicId: TopicId.optional(),
  messagesCursor: z.string().min(1).max(2048).optional(),
  tasksCursor: z.string().min(1).max(2048).optional(),
  topicsCursor: z.string().min(1).max(2048).optional(),
  channelsCursor: z.string().min(1).max(2048).optional(),
});
export function registerWorkspace(app: FastifyInstance, store: Store) {
  app.get('/api/workspace', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new IdentityError(403);
    const human = store.human(principal.humanId);
    const membership = store.teamFor(principal.humanId);
    if (!human || !membership) throw new IdentityError(403);
    const query = Query.parse(request.query);
    const teamId = membership.team.id;
    const channels = store.communication.channels(principal, teamId, {
      limit: 100,
      ...(query.channelsCursor ? { cursor: query.channelsCursor } : {}),
    });
    const id = query.channelId ?? channels.items[0]?.id;
    const channel = id
      ? store.communication.channel(principal, teamId, id)
      : null;
    const profiles = store.agents.workspaceProfiles(principal, teamId);
    const agents = profiles.agents;
    const joinedAgentIds = channel
      ? agents
          .filter((agent) => {
            if (agent.lifecycle !== 'active') return false;
            try {
              store.communication.validateParticipant(
                principal,
                teamId,
                channel.id,
                { kind: 'agent', id: agent.id },
              );
              return true;
            } catch (error) {
              if (error instanceof IdentityError && error.statusCode === 404)
                return false;
              throw error;
            }
          })
          .map((agent) => agent.id)
      : [];
    return WorkspaceSnapshot.parse({
      observedAt: new Date().toISOString(),
      human,
      team: membership.team,
      channels,
      channel,
      agents,
      agentsTruncated: profiles.truncated,
      joinedAgentIds,
      messages: channel
        ? store.communication.history(
            principal,
            teamId,
            channel.id,
            {
              ...(query.messagesCursor ? { cursor: query.messagesCursor } : {}),
            },
            query.topicId,
          )
        : { items: [], nextCursor: null },
      topics: channel
        ? store.communication.topics(principal, teamId, channel.id, {
            ...(query.topicsCursor ? { cursor: query.topicsCursor } : {}),
          })
        : { items: [], nextCursor: null },
      tasks: channel
        ? store.tasks.list(principal, teamId, channel.id, {
            ...(query.tasksCursor ? { cursor: query.tasksCursor } : {}),
          })
        : { items: [], nextCursor: null },
    });
  });
  app.get('/api/agui/:teamId/:memberId', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    z.strictObject({}).parse(request.query);
    const { teamId, memberId } = z
      .strictObject({ teamId: TeamId, memberId: AgentId })
      .parse(request.params);
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new IdentityError(403);
    // Owner membership and current identity are rechecked by each repository call.
    const snapshot = store.agents.workspaceExecutions(
      principal,
      teamId,
      memberId,
    );
    return executionEvent({
      protocolVersion: PROTOCOL_VERSION,
      source: 'kinmesh-persisted-reports',
      observedAt: new Date().toISOString(),
      ...snapshot,
    });
  });
}
