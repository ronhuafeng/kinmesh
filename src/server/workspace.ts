import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '@ag-ui/core';
import { AgentId, TeamId, type ChannelId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { INBOX_LIVENESS_MS } from '../domain/inbox.js';
import type { Reference } from '../domain/execution.js';
import type { Store } from '../persistence/store.js';
import { together } from '../persistence/database.js';
import { fingerprint } from '../persistence/transactional.js';
import type { Credential } from '../adapters/t3/oauth.js';
import type { Changes } from './changes.js';
import { payloadOf } from './notify.js';
import { readNativeExecution } from '../workspace/native.js';
import {
  ExecutionSnapshot,
  WorkspaceQuery,
  WorkspaceSnapshot,
  executionEvent,
} from '../workspace/contracts.js';

type Person = Extract<Principal, { kind: 'human' }>;
/** How long a snapshot is reused at most, with no change announced. */
const REUSE_MS = 10_000;
/** How long an in-page notice stays in the snapshot after its cause. */
const NOTICE_MS = 2 * 60 * 1000;
/** How many person-and-place snapshots are kept at once. */
const SHARED_LIMIT = 256;
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
  changes: Changes,
  /** Called for each snapshot read, shared or not. */
  counted: () => void,
  /** Where an agent's Team MCP token is used, or null without Team MCP. */
  teamMcpUrl: string | null = null,
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
  /**
   * Snapshots read since the last change, by person and place: the streams
   * of one person's place share one, and a `GET` shares one still being
   * read (a finished one may miss what changes unannounced: heartbeats,
   * presence, T3's sign-in on disk). A change, or a write through this hub
   * (whose announcement may still be on its way), forgets them all; one is
   * reused for `REUSE_MS` at most.
   */
  const shared = new Map<
    string,
    { at: number; done: boolean; snapshot: Promise<WorkspaceSnapshot> }
  >();
  const forget = () => {
    shared.clear();
  };
  changes.subscribe(forget);
  app.addHook('onSend', (request, _reply, payload, done) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') forget();
    done(null, payload);
  });
  /**
   * What one person's workspace shows for one place: one consistent read
   * (`store.read`), in which each access check is asked once and reads that
   * don't depend on each other go together.
   */
  const snapshot = (
    principal: Person,
    query: WorkspaceQuery,
    /** Only one still being read: what a `GET` asks for. */
    current = false,
  ) => {
    const key = JSON.stringify([
      principal.humanId,
      Object.entries(query).sort(([a], [b]) => (a < b ? -1 : 1)),
    ]);
    const now = Date.now();
    const kept = shared.get(key);
    if (kept && now - kept.at < REUSE_MS && !(current && kept.done))
      return kept.snapshot;
    counted();
    const entry = {
      at: now,
      done: false,
      snapshot: store.read(() => build(principal, query)),
    };
    void entry.snapshot.then(
      () => {
        entry.done = true;
      },
      () => undefined,
    );
    shared.delete(key);
    shared.set(key, entry);
    // Beyond the bound, the oldest go first.
    for (const old of shared.keys()) {
      if (shared.size <= SHARED_LIMIT) break;
      shared.delete(old);
    }
    // A failed read is not kept: the next one asks again.
    entry.snapshot.catch(() => {
      if (shared.get(key) === entry) shared.delete(key);
    });
    return entry.snapshot;
  };
  const build = async (principal: Person, query: WorkspaceQuery) => {
    const [human, membership, noticed] = await together([
      store.human(principal.humanId),
      store.teamFor(principal.humanId),
      store.notifications.recentInApp(principal.humanId, NOTICE_MS),
    ]);
    if (!human || !membership) throw new DomainError('forbidden');
    const teamId = membership.team.id;
    const open = (id: z.infer<typeof ChannelId>) =>
      store.communication.channel(principal, teamId, id);
    const [channels, named] = await together([
      store.communication.channels(principal, teamId, {
        limit: 100,
        ...(query.channelsCursor ? { cursor: query.channelsCursor } : {}),
      }),
      query.channelId ? open(query.channelId) : null,
    ]);
    const id = query.channelId ?? channels.items[0]?.id;
    const channel = named ?? (id ? await open(id) : null);
    const now = Date.now();
    const [
      profiles,
      joined,
      liveness,
      messages,
      tasks,
      opened,
      decide,
      blocked,
      queued,
      t3Renewal,
      t3,
      people,
      joinedHumanIds,
      latest,
      leftChannels,
      publicChannels,
      bindings,
      teamMcp,
      avatars,
      quiet,
      topics,
      activeTopics,
      firstUnread,
      pinned,
      archivedChannels,
      channelArchived,
      direct,
    ] = await together([
      store.agents.workspaceProfiles(principal, teamId),
      channel
        ? store.communication.joinedAgents(principal, teamId, channel.id)
        : [],
      store.inboxViews.liveness(principal, teamId),
      // The newest messages, reaching back as far as the view has scrolled.
      channel
        ? store.communication.history(
            principal,
            teamId,
            channel.id,
            {},
            query.topicId,
            query.messagesCursor,
          )
        : { items: [], nextCursor: null },
      channel
        ? store.tasks.list(principal, teamId, channel.id, { limit: 100 })
        : { items: [], nextCursor: null },
      // A task opened by its address, kept below unless the board shows it.
      channel && query.taskId !== undefined
        ? store.tasks
            .get(principal, teamId, channel.id, query.taskId)
            .catch((error: unknown) => {
              if (error instanceof DomainError && error.kind === 'not-found')
                return null;
              throw error;
            })
        : null,
      store.tasks.waitingOn(principal, teamId),
      store.inboxViews.blockedIn(principal, teamId),
      store.inboxViews.queuedPerAgent(principal, teamId),
      renewal(principal, teamId),
      store.managed.teamConnection(principal, teamId),
      store.people(principal, teamId, now),
      channel
        ? store.communication.joinedHumans(principal, teamId, channel.id)
        : [],
      store.communication.latest(principal, teamId),
      store.communication.leftChannels(principal, teamId),
      store.communication.publicChannels(principal, teamId),
      store.managed.teamBindings(principal, teamId),
      store.managed.teamMcpPresence(principal, teamId),
      store.agents.avatars(principal, teamId),
      store.notifications.quiet(principal.humanId, teamId),
      channel
        ? store.communication.topics(principal, teamId, channel.id, {
            ...(query.topicsCursor ? { cursor: query.topicsCursor } : {}),
          })
        : { items: [], nextCursor: null },
      channel
        ? store.communication.activeTopics(principal, teamId, channel.id, 10)
        : { items: [], more: false },
      // Where you stopped reading what is open, to open it there.
      channel
        ? store.communication.firstUnread(
            principal,
            teamId,
            channel.id,
            query.topicId ?? null,
          )
        : null,
      channel ? store.communication.pins(principal, teamId, channel.id) : [],
      store.communication.archivedChannels(principal, teamId),
      channel
        ? store.communication.isArchived(principal, teamId, channel.id)
        : false,
      store.communication.directChannels(principal, teamId),
    ]);
    const agents = profiles.agents;
    // In the order the profiles are listed: one read for all.
    const joinedSet = new Set<string>(joined);
    const joinedAgentIds = agents
      .filter((agent) => joinedSet.has(agent.id))
      .map((agent) => agent.id);
    const known = new Set(agents.map((agent) => agent.id));
    const wake = liveness
      .filter((row) => known.has(AgentId.parse(row.agentId)))
      .map((row) => ({
        agentId: row.agentId,
        connected: now - row.lastSeenAt <= INBOX_LIVENESS_MS,
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      }));
    // A task opened by its address is shown even when older than the board.
    const openTask =
      opened && !tasks.items.some((task) => task.id === opened.id)
        ? opened
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
      step: { waiting: boolean; text: string } | null;
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
      step: d.step,
    });
    const messageIds = messages.items.map((m) => m.id);
    const [deliveries, replies, reactions] = channel
      ? await together([
          store.inboxViews.deliveriesFor(
            principal,
            teamId,
            channel.id,
            messageIds,
            [...tasks.items, ...(openTask ? [openTask] : [])].map((t) => t.id),
          ),
          store.inboxViews.repliesFor(
            principal,
            teamId,
            channel.id,
            messageIds,
          ),
          store.communication.reactions(
            principal,
            teamId,
            channel.id,
            messageIds,
          ),
        ])
      : [[], [], []];
    // Every member reaches this route; what waits on them is theirs: tasks
    // they decide on, and the deliveries and setup the team shares.
    const live = new Set(wake.filter((w) => w.connected).map((w) => w.agentId));
    const attention = {
      decide,
      unstuck: blocked
        .filter((d) => known.has(AgentId.parse(d.agentId)))
        .map((d) => ({
          ...project(d),
          channelId: d.channelId,
          channelName: d.channelName,
        })),
      connect: queued
        .filter(
          (q) => known.has(AgentId.parse(q.agentId)) && !live.has(q.agentId),
        )
        .map((q) => ({ agentId: q.agentId, queued: q.count })),
      t3: t3Renewal,
    };
    const t3Origin = t3 ? new URL(t3.endpoint).origin : null;
    const listed = new Set<string>(channels.items.map((c) => c.id));
    // What just concerned the person while they were here, as it reads now.
    const notices = [];
    for (const n of noticed) {
      const about = await store.notifications.describe(n);
      if (about === null) continue;
      const shown = payloadOf(n, about);
      notices.push({
        id: n.id,
        title: shown.title,
        body: shown.body,
        url: shown.url,
      });
    }
    // Two people's own conversation is called by who it is with, as they
    // are called now.
    const withWhom = new Map<string, string>(
      direct.map((d) => [d.channelId, d.humanId]),
    );
    const called = <C extends { id: string; name: string }>(c: C): C => {
      const other = withWhom.get(c.id);
      const name =
        other === undefined
          ? undefined
          : people.find((person) => person.id === other)?.name;
      return name === undefined ? c : { ...c, name };
    };
    return WorkspaceSnapshot.parse(
      withRevision({
        observedAt: new Date(now).toISOString(),
        nativeT3Origin: t3Origin,
        teamMcpUrl,
        firstUnread,
        reactions,
        pinned,
        archivedChannels: archivedChannels.map(called),
        channelArchived,
        direct,
        human,
        levels: quiet.levels,
        notices,
        pausedUntil: quiet.pausedUntil,
        forwardAfter: quiet.forwardAfter,
        hours: quiet.hours,
        team: membership.team,
        people,
        joinedHumanIds,
        channels: { ...channels, items: channels.items.map(called) },
        latest: latest.filter((l) => listed.has(l.channelId)),
        channel: channel && called(channel),
        leftChannels: leftChannels.map(called),
        publicChannels,
        agents,
        agentsTruncated: profiles.truncated,
        joinedAgentIds,
        deliveries: deliveries.map(project),
        replies,
        attention,
        wake,
        managed: bindings.filter((b) => known.has(AgentId.parse(b.agentId))),
        teamMcp: teamMcp
          .filter((row) => known.has(AgentId.parse(row.agentId)))
          .map((row) => ({
            agentId: row.agentId,
            lastSeenAt: new Date(row.lastSeenAt).toISOString(),
          })),
        avatars: avatars.filter((row) => known.has(AgentId.parse(row.agentId))),
        messages,
        topics,
        activeTopics,
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
    return snapshot(principal, WorkspaceQuery.parse(request.query), true);
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
