import type { z } from 'zod';
import { PROTOCOL_VERSION } from '@ag-ui/core';
import type { TeamId } from '../domain/contracts.js';
import { AgentId, type ChannelId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { INBOX_LIVENESS_MS } from '../domain/inbox.js';
import type { Store } from '../persistence/store.js';
import { together } from '../persistence/database.js';
import { fingerprint } from '../persistence/transactional.js';
import type { Changes } from './changes.js';
import { payloadOf } from './notify.js';
import type { WorkspaceQuery } from '../workspace/contracts.js';
import {
  ExecutionSnapshot,
  WorkspaceSnapshot,
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
 * What one person's workspace shows: the snapshot of a place, and an
 * agent's runs, each read consistently and shared between the readers of
 * one person's place until something changes (`forget`, also after any
 * write through this hub).
 */
export function workspaceReader(
  store: Store,
  /** T3's sign-in when it needs renewing by a person (`registerConnect`). */
  renewal: (principal: Person, teamId: TeamId) => Promise<unknown>,
  changes: Changes,
  /** Called for each snapshot read, shared or not. */
  counted: () => void,
  /** Where an agent's Team MCP token is used, or null without Team MCP. */
  teamMcpUrl: string | null = null,
) {
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
      store.channels.channel(principal, teamId, id);
    const [channels, named] = await together([
      store.channels.channels(principal, teamId, {
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
      channel ? store.channels.joinedAgents(principal, teamId, channel.id) : [],
      store.inboxViews.liveness(principal, teamId),
      // The newest messages, reaching back as far as the view has scrolled.
      channel
        ? store.messages.history(
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
      store.t3Connections.teamConnection(principal, teamId),
      store.people(principal, teamId, now),
      channel ? store.channels.joinedHumans(principal, teamId, channel.id) : [],
      store.channels.latest(principal, teamId),
      store.channels.leftChannels(principal, teamId),
      store.channels.publicChannels(principal, teamId),
      store.managed.teamBindings(principal, teamId),
      store.teamMcpPresence.teamMcpPresence(principal, teamId),
      store.agents.avatars(principal, teamId),
      store.quiet.quiet(principal.humanId, teamId),
      channel
        ? store.topics.topics(principal, teamId, channel.id, {
            ...(query.topicsCursor ? { cursor: query.topicsCursor } : {}),
          })
        : { items: [], nextCursor: null },
      channel
        ? store.topics.activeTopics(principal, teamId, channel.id, 10)
        : { items: [], more: false },
      // Where you stopped reading what is open, to open it there.
      channel
        ? store.channels.firstUnread(
            principal,
            teamId,
            channel.id,
            query.topicId ?? null,
          )
        : null,
      channel ? store.pins.pins(principal, teamId, channel.id) : [],
      store.channels.archivedChannels(principal, teamId),
      channel
        ? store.channels.isArchived(principal, teamId, channel.id)
        : false,
      store.channels.directChannels(principal, teamId),
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
    const [deliveries, replies, reactions, taskPullRequests] = channel
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
          store.reactions.reactions(principal, teamId, channel.id, messageIds),
          opened
            ? store.tasks.pullRequests(principal, teamId, channel.id, opened.id)
            : [],
        ])
      : [[], [], [], []];
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
        taskPullRequests,
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
  return { snapshot, runs, forget };
}
export type WorkspaceReader = ReturnType<typeof workspaceReader>;
