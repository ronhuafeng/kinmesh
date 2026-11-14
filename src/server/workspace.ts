import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '@ag-ui/core';
import { AgentId, TeamId } from '../domain/contracts.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import { INBOX_LIVENESS_MS } from '../domain/inbox.js';
import type { Store } from '../persistence/store.js';
import { fingerprint } from '../persistence/transactional.js';
import { loadCredential } from '../adapters/t3/oauth.js';
import { readNativeExecution } from '../workspace/native.js';
import {
  ExecutionSnapshot,
  WorkspaceQuery,
  WorkspaceSnapshot,
  executionEvent,
} from '../workspace/contracts.js';

type Person = Extract<Principal, { kind: 'human' }>;
/**
 * Names what a snapshot shows. The time it was read and worker heartbeats,
 * which change nothing on screen, are left out.
 */
function withRevision<
  T extends { wake: { agentId: string; connected: boolean }[] },
>(view: T) {
  return {
    ...view,
    revision: fingerprint({
      ...view,
      observedAt: null,
      wake: view.wake.map(({ agentId, connected }) => ({ agentId, connected })),
    }),
  };
}
/**
 * `t3CredentialFile` is the team's T3 credential, the one approved in the
 * workspace: checking a run reads T3 through the same connection agents use.
 */
export function registerWorkspace(
  app: FastifyInstance,
  store: Store,
  t3CredentialFile: string,
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
        const connection = store.managed.teamConnection(teamId);
        if (!connection) throw new Error('Unavailable');
        const credential = loadCredential(
          t3CredentialFile,
          connection.endpoint,
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
  /** What one person's workspace shows for one place. */
  const snapshot = (principal: Person, query: WorkspaceQuery) => {
    const human = store.human(principal.humanId);
    const membership = store.teamFor(principal.humanId);
    if (!human || !membership) throw new IdentityError(403);
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
    // Every member reaches this route; what waits on them is theirs: tasks
    // they decide on, and the deliveries and setup the team shares.
    const live = new Set(wake.filter((w) => w.connected).map((w) => w.agentId));
    const attention = {
      decide: store.tasks.waitingOn(principal, teamId),
      unstuck: store.inbox
        .blockedIn(teamId, principal.humanId)
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
    const t3 = store.managed.teamConnection(teamId);
    const t3Origin = t3 ? new URL(t3.endpoint).origin : null;
    return WorkspaceSnapshot.parse(
      withRevision({
        observedAt: new Date(now).toISOString(),
        nativeT3Origin: t3Origin,
        human,
        team: membership.team,
        people: store.people(teamId, now),
        joinedHumanIds: channel
          ? store.communication.joinedHumans(principal, teamId, channel.id)
          : [],
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
        avatars: store.agents
          .avatars(principal, teamId)
          .filter((row) => known.has(AgentId.parse(row.agentId))),
        messages,
        topics: channel
          ? store.communication.topics(principal, teamId, channel.id, {
              ...(query.topicsCursor ? { cursor: query.topicsCursor } : {}),
            })
          : { items: [], nextCursor: null },
        activeTopics: channel
          ? store.communication.activeTopics(principal, teamId, channel.id, 10)
          : { items: [], more: false },
        tasks,
      }),
    );
  };
  /** An agent's runs as Kinmesh recorded them; the read time is not part of what they show. */
  const runs = (principal: Person, teamId: TeamId, agentId: AgentId) => {
    // Membership and current identity are rechecked by each repository call.
    const executions = store.agents.workspaceExecutions(
      principal,
      teamId,
      agentId,
    );
    return ExecutionSnapshot.parse({
      protocolVersion: PROTOCOL_VERSION,
      source: 'kinmesh-persisted-reports',
      observedAt: new Date().toISOString(),
      revision: fingerprint(executions),
      ...executions,
    });
  };
  app.get('/api/workspace', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new IdentityError(403);
    return snapshot(principal, WorkspaceQuery.parse(request.query));
  });
  app.get('/api/agui/:teamId/:memberId', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    z.strictObject({}).parse(request.query);
    const { teamId, memberId } = z
      .strictObject({ teamId: TeamId, memberId: AgentId })
      .parse(request.params);
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new IdentityError(403);
    return executionEvent(runs(principal, teamId, memberId));
  });
  return { snapshot, runs };
}
