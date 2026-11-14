import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { communicationRepository } from './communication.js';
import type { Database } from './database.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import type {
  ChannelId as ChannelIdSchema,
  TeamId,
} from '../domain/contracts.js';
import { FrozenLaunch, InboxState, PublishedOutcome } from '../domain/inbox.js';

type ChannelId = z.infer<typeof ChannelIdSchema>;
const decode = (value: string): unknown => JSON.parse(value);

/**
 * What the workspace shows a person about deliveries, replies and workers.
 * Every read checks its caller in the same transaction: a person of the
 * team, and one who can read the channel where a channel is named. Agents
 * never read these; worker internals never leave them.
 */
export function inboxViews(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
  communication: ReturnType<typeof communicationRepository>,
) {
  const { q, atomic } = d;
  const t = s.agentInbox;
  async function person(p: Principal, teamId: TeamId) {
    // Agents are refused before their grant is looked at.
    if (p.kind !== 'human') throw new IdentityError(403);
    await agents.person(p, teamId);
    return p;
  }
  async function inChannel(p: Principal, teamId: TeamId, channelId: ChannelId) {
    await person(p, teamId);
    await communication.channel(p, teamId, channelId);
  }
  /** First and last recorded transition, for "queued 2 h ago" copy. */
  async function withTimes<R extends { id: string; state: string }>(rows: R[]) {
    if (rows.length === 0) return [];
    const times = new Map(
      (
        await q()
          .select({
            id: s.inboxHistory.deliveryId,
            first: sql<number>`min(${s.inboxHistory.createdAt})::float8`,
            last: sql<number>`max(${s.inboxHistory.createdAt})::float8`,
          })
          .from(s.inboxHistory)
          .where(
            inArray(
              s.inboxHistory.deliveryId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(s.inboxHistory.deliveryId)
      ).map((r) => [r.id, r]),
    );
    return rows.map((r) => ({
      ...r,
      state: InboxState.parse(r.state),
      queuedAt: times.get(r.id)?.first ?? null,
      updatedAt: times.get(r.id)?.last ?? null,
    }));
  }
  return {
    /**
     * A channel page's deliveries: mention deliveries of the given messages,
     * deliveries answered by them, and task wakes.
     */
    deliveriesFor(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageIds: string[],
      taskIds: string[],
    ) {
      return atomic(async () => {
        await inChannel(p, teamId, channelId);
        const ids = z.array(z.uuid()).max(100).parse(messageIds);
        const tasks = z.array(z.uuid()).max(100).parse(taskIds);
        if (ids.length === 0 && tasks.length === 0) return [];
        const rows = await q()
          .select({
            id: t.id,
            position: t.position,
            agentId: t.agentId,
            messageId: t.messageId,
            taskId: t.taskId,
            state: t.state,
            reason: t.reason,
            resultMessageId: t.resultMessageId,
          })
          .from(t)
          .where(
            and(
              eq(t.teamId, teamId),
              eq(t.channelId, channelId),
              or(
                ids.length ? inArray(t.messageId, ids) : undefined,
                ids.length ? inArray(t.resultMessageId, ids) : undefined,
                tasks.length ? inArray(t.taskId, tasks) : undefined,
              ),
            ),
          )
          .orderBy(asc(t.position));
        return withTimes(rows);
      });
    },
    /**
     * Blocked deliveries the caller caused — the root of what woke the agent
     * is theirs — in channels they are joined to, newest first. Anyone may
     * resume one; each person is asked only about their own.
     */
    blockedIn(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        const { humanId } = await person(p, teamId);
        const member = `human:${humanId}`;
        const rows = await q()
          .select({
            id: t.id,
            position: t.position,
            agentId: t.agentId,
            channelId: t.channelId,
            channelName: s.channels.name,
            messageId: t.messageId,
            taskId: t.taskId,
            state: t.state,
            reason: t.reason,
            resultMessageId: t.resultMessageId,
          })
          .from(t)
          .innerJoin(s.channels, eq(s.channels.id, t.channelId))
          .innerJoin(
            s.channelParticipants,
            and(
              eq(s.channelParticipants.channelId, t.channelId),
              eq(s.channelParticipants.memberKey, member),
              eq(s.channelParticipants.state, 'joined'),
            ),
          )
          .innerJoin(s.inboxCauses, eq(s.inboxCauses.eventId, t.eventId))
          .innerJoin(
            s.communicationOutbox,
            eq(s.communicationOutbox.id, s.inboxCauses.rootId),
          )
          .where(
            and(
              eq(t.teamId, teamId),
              eq(t.state, 'blocked'),
              sql`(${s.communicationOutbox.fact}::jsonb -> 'author' ->> 'kind') = 'human'`,
              sql`(${s.communicationOutbox.fact}::jsonb -> 'author' ->> 'humanId') = ${humanId}`,
            ),
          )
          .orderBy(sql`${t.position} DESC`)
          .limit(50);
        return withTimes(rows);
      });
    },
    /** Deliveries still waiting for a worker to pick them up, per agent. */
    queuedPerAgent(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await person(p, teamId);
        return await q()
          .select({ agentId: t.agentId, count: sql<number>`count(*)::int` })
          .from(t)
          .where(and(eq(t.teamId, teamId), eq(t.state, 'ready')))
          .groupBy(t.agentId);
      });
    },
    /**
     * Where each visible agent reply came from: the run's outcome, the model
     * it ran on and its T3 identifiers. No prompts or tokens.
     */
    repliesFor(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageIds: string[],
    ) {
      return atomic(async () => {
        await inChannel(p, teamId, channelId);
        const ids = z.array(z.uuid()).max(100).parse(messageIds);
        if (ids.length === 0) return [];
        return (
          await q()
            .select({
              messageId: s.inboxResults.messageId,
              result: s.inboxResults.result,
              agentId: t.agentId,
              launch: t.launch,
            })
            .from(s.inboxResults)
            .innerJoin(t, eq(t.id, s.inboxResults.deliveryId))
            .where(
              and(
                eq(t.teamId, teamId),
                eq(t.channelId, channelId),
                inArray(s.inboxResults.messageId, ids),
              ),
            )
        ).map((r) => {
          const outcome = PublishedOutcome.parse(decode(r.result));
          const model =
            r.launch === null
              ? null
              : FrozenLaunch.parse(decode(r.launch)).input.model;
          return {
            messageId: r.messageId,
            agentId: r.agentId,
            state: outcome.state,
            answered: !('kind' in outcome),
            excerpt: 'kind' in outcome ? false : outcome.truncated,
            providerId: model?.providerId ?? null,
            modelId: model?.modelId ?? null,
            environmentId: outcome.reference.environmentId,
            threadId: outcome.reference.threadId,
            runId: outcome.reference.runId,
          };
        });
      });
    },
    /** When a worker last vouched for each of the team's agents. */
    liveness(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await person(p, teamId);
        return await q()
          .select({
            agentId: s.inboxBindings.agentId,
            lastSeenAt: s.inboxBindings.lastSeenAt,
          })
          .from(s.inboxBindings)
          .where(eq(s.inboxBindings.teamId, teamId));
      });
    },
  };
}
