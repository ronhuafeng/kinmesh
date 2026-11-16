import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '@ag-ui/core';
import { AgentId, TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { INBOX_LIVENESS_MS } from '../domain/inbox.js';
import type { Reference } from '../domain/execution.js';
import type { Store } from '../persistence/store.js';
import { fingerprint } from '../persistence/transactional.js';
import type { Credential } from '../adapters/t3/oauth.js';
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
 * `runCredential` is the team's T3 credential agents' runs use now: checking
 * a run reads T3 through the same connection they use.
 */
export function registerWorkspace(
  app: FastifyInstance,
  store: Store,
  runCredential: (endpoint: string) => Credential | null,
  /** T3's sign-in when it needs renewing by a person (`registerConnect`). */
  renewal: (principal: Person, teamId: TeamId) => Promise<unknown>,
) {
  /** One read of a run through the team's T3 connection, the one runs use. */
  async function readRun(
    principal: Person,
    teamId: TeamId,
    reference: z.infer<typeof Reference>,
  ) {
    const connection = await store.managed.teamConnection(principal, teamId);
    if (!connection) throw new Error('Unavailable');
    const credential = runCredential(connection.endpoint);
    if (credential?.environmentId !== reference.environmentId)
      throw new Error('Unavailable');
    return readNativeExecution(
      credential,
      reference,
      AbortSignal.timeout(8000),
    );
  }
  app.get(
    '/api/teams/:teamId/agents/:agentId/executions/:executionId/native',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principal = request.principal;
      if (principal?.kind !== 'human') throw new DomainError('forbidden');
      const { teamId, agentId, executionId } = z
        .strictObject({
          teamId: TeamId,
          agentId: AgentId,
          executionId: z.uuid(),
        })
        .parse(request.params);
      z.strictObject({}).parse(request.query);
      // Do not mask Kinmesh authorization denials as external-service outages.
      const correlation = await store.agents.getCorrelation(
        principal,
        teamId,
        agentId,
        executionId,
      );
      try {
        const observation = await readRun(
          principal,
          teamId,
          correlation.reference,
        );
        // Access may have changed while the external read was in flight.
        await store.agents.getCorrelation(
          principal,
          teamId,
          agentId,
          executionId,
        );
        return observation;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        // A concurrent Kinmesh access loss still takes precedence over an upstream outage.
        await store.agents.getCorrelation(
          principal,
          teamId,
          agentId,
          executionId,
        );
        // External OAuth/permission failures are never Kinmesh session expiry.
        return reply.code(503).send({ error: 'Native T3 status unavailable' });
      }
    },
  );
  /**
   * Where T3 shows a delivery's run, for going there to approve what it waits
   * for: its thread on the team's T3 origin, or null before it is in T3.
   */
  app.get(
    '/api/teams/:teamId/deliveries/:deliveryId/link',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const principal = request.principal;
      if (principal?.kind !== 'human') throw new DomainError('forbidden');
      const { teamId, deliveryId } = z
        .strictObject({ teamId: TeamId, deliveryId: z.uuid() })
        .parse(request.params);
      z.strictObject({}).parse(request.query);
      const run = await store.inbox.runOf(principal, teamId, deliveryId);
      if (run === null) return { url: null };
      try {
        const { verifiedUrl } = await readRun(principal, teamId, run);
        // Access may have changed while T3 was read.
        await store.inbox.runOf(principal, teamId, deliveryId);
        return { url: verifiedUrl };
      } catch (error) {
        if (error instanceof DomainError) throw error;
        await store.inbox.runOf(principal, teamId, deliveryId);
        return reply.code(503).send({ error: 'Native T3 status unavailable' });
      }
    },
  );
  /** What one person's workspace shows for one place. */
  const snapshot = async (principal: Person, query: WorkspaceQuery) => {
    const human = await store.human(principal.humanId);
    const membership = await store.teamFor(principal.humanId);
    if (!human || !membership) throw new DomainError('forbidden');
    const teamId = membership.team.id;
    const channels = await store.communication.channels(principal, teamId, {
      limit: 100,
      ...(query.channelsCursor ? { cursor: query.channelsCursor } : {}),
    });
    const id = query.channelId ?? channels.items[0]?.id;
    const channel = id
      ? await store.communication.channel(principal, teamId, id)
      : null;
    const profiles = await store.agents.workspaceProfiles(principal, teamId);
    const agents = profiles.agents;
    // In the order the profiles are listed, as before: one read for all.
    const joined = new Set(
      channel
        ? await store.communication.joinedAgents(principal, teamId, channel.id)
        : [],
    );
    const joinedAgentIds = agents
      .filter((agent) => joined.has(agent.id))
      .map((agent) => agent.id);
    const now = Date.now();
    const known = new Set(agents.map((agent) => agent.id));
    const wake = (await store.inboxViews.liveness(principal, teamId))
      .filter((row) => known.has(AgentId.parse(row.agentId)))
      .map((row) => ({
        agentId: row.agentId,
        connected: now - row.lastSeenAt <= INBOX_LIVENESS_MS,
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      }));
    // The newest messages, reaching back as far as the view has scrolled.
    const messages = channel
      ? await store.communication.history(
          principal,
          teamId,
          channel.id,
          {},
          query.topicId,
          query.messagesCursor,
        )
      : { items: [], nextCursor: null };
    const tasks = channel
      ? await store.tasks.list(principal, teamId, channel.id, { limit: 100 })
      : { items: [], nextCursor: null };
    // A task opened by its address is shown even when older than the board.
    const openTask =
      channel &&
      query.taskId !== undefined &&
      !tasks.items.some((task) => task.id === query.taskId)
        ? await store.tasks
            .get(principal, teamId, channel.id, query.taskId)
            .catch((error: unknown) => {
              if (error instanceof DomainError && error.kind === 'not-found')
                return null;
              throw error;
            })
        : null;
    // The projection is allow-listed.
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
      stopRequested: boolean;
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
      stopRequested: d.stopRequested,
    });
    const deliveries = channel
      ? (
          await store.inboxViews.deliveriesFor(
            principal,
            teamId,
            channel.id,
            messages.items.map((m) => m.id),
            [...tasks.items, ...(openTask ? [openTask] : [])].map((t) => t.id),
          )
        ).map(project)
      : [];
    // Every member reaches this route; what waits on them is theirs: tasks
    // they decide on, and the deliveries and setup the team shares.
    const live = new Set(wake.filter((w) => w.connected).map((w) => w.agentId));
    const attention = {
      decide: await store.tasks.waitingOn(principal, teamId),
      unstuck: (await store.inboxViews.blockedIn(principal, teamId))
        .filter((d) => known.has(AgentId.parse(d.agentId)))
        .map((d) => ({
          ...project(d),
          channelId: d.channelId,
          channelName: d.channelName,
        })),
      connect: (await store.inboxViews.queuedPerAgent(principal, teamId))
        .filter(
          (q) => known.has(AgentId.parse(q.agentId)) && !live.has(q.agentId),
        )
        .map((q) => ({ agentId: q.agentId, queued: q.count })),
      t3: await renewal(principal, teamId),
    };
    const t3 = await store.managed.teamConnection(principal, teamId);
    const t3Origin = t3 ? new URL(t3.endpoint).origin : null;
    return WorkspaceSnapshot.parse(
      withRevision({
        observedAt: new Date(now).toISOString(),
        nativeT3Origin: t3Origin,
        human,
        team: membership.team,
        people: await store.people(principal, teamId, now),
        joinedHumanIds: channel
          ? await store.communication.joinedHumans(
              principal,
              teamId,
              channel.id,
            )
          : [],
        channels,
        channel,
        leftChannels: await store.communication.leftChannels(principal, teamId),
        agents,
        agentsTruncated: profiles.truncated,
        joinedAgentIds,
        deliveries,
        replies: channel
          ? await store.inboxViews.repliesFor(
              principal,
              teamId,
              channel.id,
              messages.items.map((m) => m.id),
            )
          : [],
        attention,
        wake,
        managed: (await store.managed.teamBindings(principal, teamId)).filter(
          (b) => known.has(AgentId.parse(b.agentId)),
        ),
        teamMcp: (await store.managed.teamMcpPresence(principal, teamId))
          .filter((row) => known.has(AgentId.parse(row.agentId)))
          .map((row) => ({
            agentId: row.agentId,
            lastSeenAt: new Date(row.lastSeenAt).toISOString(),
          })),
        avatars: (await store.agents.avatars(principal, teamId)).filter((row) =>
          known.has(AgentId.parse(row.agentId)),
        ),
        messages,
        topics: channel
          ? await store.communication.topics(principal, teamId, channel.id, {
              ...(query.topicsCursor ? { cursor: query.topicsCursor } : {}),
            })
          : { items: [], nextCursor: null },
        activeTopics: channel
          ? await store.communication.activeTopics(
              principal,
              teamId,
              channel.id,
              10,
            )
          : { items: [], more: false },
        tasks,
        openTask,
      }),
    );
  };
  /** An agent's runs as Kinmesh recorded them; the read time is not part of what they show. */
  const runs = async (principal: Person, teamId: TeamId, agentId: AgentId) => {
    // Membership and current identity are rechecked by each repository call.
    const executions = await store.agents.workspaceExecutions(
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
    if (principal?.kind !== 'human') throw new DomainError('forbidden');
    return snapshot(principal, WorkspaceQuery.parse(request.query));
  });
  app.get('/api/agui/:teamId/:memberId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    z.strictObject({}).parse(request.query);
    const { teamId, memberId } = z
      .strictObject({ teamId: TeamId, memberId: AgentId })
      .parse(request.params);
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new DomainError('forbidden');
    return executionEvent(await runs(principal, teamId, memberId));
  });
  return { snapshot, runs };
}
