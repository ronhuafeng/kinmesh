import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '@ag-ui/core';
import { AgentId, ChannelId, TeamId } from '../domain/contracts.js';
import { IdentityError } from '../domain/agents.js';
import { TopicId, memberKey } from '../domain/communication.js';
import { INBOX_LIVENESS_MS } from '../domain/inbox.js';
import type { Store } from '../persistence/store.js';
import type { Config } from './config.js';
import { loadCredential } from '../adapters/t3/oauth.js';
import { readNativeExecution } from '../workspace/native.js';
import { WorkspaceSnapshot, executionEvent } from '../workspace/contracts.js';

const Query = z.strictObject({
  channelId: ChannelId.optional(),
  topicId: TopicId.optional(),
  messagesCursor: z.string().min(1).max(2048).optional(),
  tasksCursor: z.string().min(1).max(2048).optional(),
  topicsCursor: z.string().min(1).max(2048).optional(),
  channelsCursor: z.string().min(1).max(2048).optional(),
});
export function registerWorkspace(
  app: FastifyInstance,
  store: Store,
  config: Config,
) {
  app.get(
    '/api/teams/:teamId/agents/:agentId/executions/:executionId/native',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principal = request.principal;
      if (principal?.kind !== 'human') throw new IdentityError(403);
      const { teamId, agentId, executionId } = z
        .strictObject({
          teamId: TeamId,
          agentId: AgentId,
          executionId: z.uuid(),
        })
        .parse(request.params);
      z.strictObject({}).parse(request.query);
      // Do not mask Kinmesh authorization denials as external-service outages.
      const correlation = store.agents.getCorrelation(
        principal,
        teamId,
        agentId,
        executionId,
      );
      try {
        if (!config.nativeT3) throw new Error('Unavailable');
        const credential = loadCredential(
          config.nativeT3.authFile,
          config.nativeT3.endpoint,
        );
        if (credential.environmentId !== correlation.reference.environmentId)
          throw new Error('Unavailable');
        const observation = await readNativeExecution(
          credential,
          correlation.reference,
          AbortSignal.timeout(8000),
        );
        // Access may have changed while the external read was in flight.
        store.agents.getCorrelation(principal, teamId, agentId, executionId);
        return observation;
      } catch (error) {
        if (error instanceof IdentityError) throw error;
        // A concurrent Kinmesh access loss still takes precedence over an upstream outage.
        store.agents.getCorrelation(principal, teamId, agentId, executionId);
        // External OAuth/permission failures are never Kinmesh session expiry.
        return reply.code(503).send({ error: 'Native T3 status unavailable' });
      }
    },
  );
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
    const now = Date.now();
    const known = new Set(agents.map((agent) => agent.id));
    const wake = store.inbox
      .liveness(teamId)
      .filter((row) => known.has(AgentId.parse(row.agentId)))
      .map((row) => ({
        agentId: row.agentId,
        connected: now - row.lastSeenAt <= INBOX_LIVENESS_MS,
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      }));
    const messages = channel
      ? store.communication.history(
          principal,
          teamId,
          channel.id,
          {
            ...(query.messagesCursor ? { cursor: query.messagesCursor } : {}),
          },
          query.topicId,
        )
      : { items: [], nextCursor: null };
    const tasks = channel
      ? store.tasks.list(principal, teamId, channel.id, {
          ...(query.tasksCursor ? { cursor: query.tasksCursor } : {}),
        })
      : { items: [], nextCursor: null };
    // Channel access was authorized above; the projection is allow-listed.
    const iso = (ms: number | null) =>
      ms === null ? null : new Date(ms).toISOString();
    const project = (d: {
      id: string;
      agentId: string;
      messageId: string | null;
      taskId: string | null;
      state: string;
      reason: string;
      queuedAt: number | null;
      updatedAt: number | null;
      resultMessageId: string | null;
    }) => ({
      id: d.id,
      agentId: d.agentId,
      messageId: d.messageId,
      taskId: d.taskId,
      state: d.state,
      reason: d.reason,
      queuedAt: iso(d.queuedAt),
      updatedAt: iso(d.updatedAt),
      resultMessageId: d.resultMessageId,
    });
    const deliveries = channel
      ? store.inbox
          .deliveriesFor(
            teamId,
            channel.id,
            messages.items.map((m) => m.id),
            tasks.items.map((t) => t.id),
          )
          .map(project)
      : [];
    // Only owners reach this route (teamFor), so recovery and setup items are theirs.
    const me = memberKey({ kind: 'human', id: principal.humanId });
    const live = new Set(wake.filter((w) => w.connected).map((w) => w.agentId));
    const attention = {
      decide: store.tasks.waitingOn(principal, teamId),
      unstuck: store.inbox
        .blockedIn(teamId, me)
        .filter((d) => known.has(AgentId.parse(d.agentId)))
        .map((d) => ({
          ...project(d),
          channelId: d.channelId,
          channelName: d.channelName,
        })),
      connect: store.inbox
        .queuedPerAgent(teamId)
        .filter(
          (q) => known.has(AgentId.parse(q.agentId)) && !live.has(q.agentId),
        )
        .map((q) => ({ agentId: q.agentId, queued: q.count })),
    };
    return WorkspaceSnapshot.parse({
      observedAt: new Date(now).toISOString(),
      nativeT3Origin: config.nativeT3
        ? new URL(config.nativeT3.endpoint).origin
        : null,
      human,
      team: membership.team,
      channels,
      channel,
      leftChannels: store.communication.leftChannels(principal, teamId),
      agents,
      agentsTruncated: profiles.truncated,
      joinedAgentIds,
      deliveries,
      replies: channel
        ? store.inbox.repliesFor(
            teamId,
            channel.id,
            messages.items.map((m) => m.id),
          )
        : [],
      attention,
      wake,
      managed: store.managed
        .teamBindings(teamId)
        .filter((b) => known.has(AgentId.parse(b.agentId))),
      teamMcp: store.managed
        .teamMcpPresence(teamId)
        .filter((row) => known.has(AgentId.parse(row.agentId)))
        .map((row) => ({
          agentId: row.agentId,
          lastSeenAt: new Date(row.lastSeenAt).toISOString(),
        })),
      messages,
      topics: channel
        ? store.communication.topics(principal, teamId, channel.id, {
            ...(query.topicsCursor ? { cursor: query.topicsCursor } : {}),
          })
        : { items: [], nextCursor: null },
      tasks,
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
