import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { communicationRepository } from './communication.js';
import type { taskRepository } from './tasks.js';
import { referenceKey, transactional } from './transactional.js';
import { dbNow, type Database } from './database.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { AgentId, ChannelId, TeamId } from '../domain/contracts.js';
import { MessageId, OutboxFact, memberKey } from '../domain/communication.js';
import {
  Claim,
  Delivery,
  FrozenLaunch,
  INBOX_CAPACITY,
  INBOX_LEASE_MS,
  INBOX_LIVENESS_MS,
  SourceContext,
  PublishedOutcome,
  clip,
  retryDelay,
  waitDelay,
  InboxState,
  deliveryScopes,
  inboxIntent,
  type BlockedReason,
  type DeliveryReason,
} from '../domain/inbox.js';
import { Reference, executionScope } from '../domain/execution.js';
import {
  actingMember,
  retainsExecutionResponsibility,
  type Task,
} from '../domain/tasks.js';

const decode = (value: string): unknown => JSON.parse(value);
/**
 * `column` is one of `ids`, sent as one array: a worker serves any number of
 * agents, where a parameter each would meet PostgreSQL's limit.
 */
const among = (column: AnyPgColumn, ids: readonly string[]) =>
  sql`${column} = any(${sql.param(ids)}::text[])`;
/**
 * The delivery's launch may be in T3: it was correlated, or its native
 * intent was journaled, which happens before T3 is called (the strings are
 * `inboxIntent`'s, as in drizzle/0001_rules.sql). A frozen launch alone
 * never reached T3.
 */
const mayBeInT3 = sql`(${s.agentInbox.operationId} IS NOT NULL OR ${s.agentInbox.reference} IS NOT NULL OR EXISTS (SELECT 1 FROM execution_operations o WHERE o.actor = 'inbox-agent:' || ${s.agentInbox.agentId} AND o.operation_key = 'inbox:' || ${s.agentInbox.id}))`;
/** The advisory lock claims take turns under (any fixed 64-bit key). */
const CLAIM_LOCK = 0x6b696e6d657368n;
export function inboxRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
  communication: ReturnType<typeof communicationRepository>,
  tasks: ReturnType<typeof taskRepository>,
) {
  const { q, atomic, receipt } = transactional(d);
  const t = s.agentInbox;
  async function get(id: string) {
    z.uuid().parse(id);
    return Delivery.parse(
      (await q().select().from(t).where(eq(t.id, id)).limit(1))[0],
    );
  }
  function fence(c: Claim) {
    Claim.parse(c);
    return and(
      eq(t.id, c.id),
      eq(t.generation, c.generation),
      eq(t.claimToken, c.claimToken),
      gt(t.leaseUntil, dbNow),
    );
  }
  async function owned(c: Claim) {
    if (!(await q().select({ id: t.id }).from(t).where(fence(c)).limit(1))[0])
      throw new DomainError('conflict');
  }
  /** The delivery's latest recorded transition. */
  async function recorded(id: string) {
    return (
      await q()
        .select({
          state: s.inboxHistory.state,
          reason: s.inboxHistory.reason,
          /** How long ago, by the database's clock. */
          age: sql<number>`(${dbNow} - ${s.inboxHistory.createdAt})::float8`,
        })
        .from(s.inboxHistory)
        .where(eq(s.inboxHistory.deliveryId, id))
        .orderBy(desc(s.inboxHistory.position))
        .limit(1)
    )[0];
  }
  /**
   * Records a transition: a change of state or reason. Looking again and
   * finding the same is not one, so a long wait keeps its history.
   */
  async function history(row: Delivery, reason: string) {
    const last = await recorded(row.id);
    if (last?.state === row.state && last.reason === reason) return;
    const count =
      (
        await q()
          .select({ n: sql<number>`count(*)::int` })
          .from(s.inboxHistory)
          .where(eq(s.inboxHistory.deliveryId, row.id))
          .limit(1)
      )[0]?.n ?? 0;
    // Keep bounded diagnostic snapshots plus a reserved final ACK; immutable source/audit/result is retained.
    if (count >= (row.state === 'acked' ? 128 : 127)) return;
    await q().insert(s.inboxHistory).values({
      deliveryId: row.id,
      generation: row.generation,
      state: row.state,
      reason,
      createdAt: dbNow,
    });
  }
  /** A person or agent by the name the workspace shows. */
  async function authorName(author: z.infer<typeof OutboxFact>['author']) {
    const row =
      author.kind === 'human'
        ? (
            await q()
              .select({ name: s.humans.username })
              .from(s.humans)
              .where(eq(s.humans.id, author.humanId))
              .limit(1)
          )[0]
        : (
            await q()
              .select({ name: s.agents.name })
              .from(s.agents)
              .where(eq(s.agents.id, author.agentId))
              .limit(1)
          )[0];
    return row?.name ?? 'someone';
  }
  /** Blocked → retry with the frozen intent; never a new native operation key. */
  async function reopen(id: string, reason: DeliveryReason) {
    const row = await get(id);
    if (row.state !== 'blocked') throw new DomainError('conflict');
    const changed = await q()
      .update(t)
      .set({
        state: row.reference === null ? 'uncertain' : 'waiting',
        reason,
        nextAttempt: dbNow,
      })
      .where(
        and(eq(t.id, id), eq(t.state, 'blocked'), lte(t.leaseUntil, dbNow)),
      );
    if (changed.count !== 1) throw new DomainError('conflict');
    await history(await get(id), reason);
  }
  /**
   * Whether the task still has this agent act on this delivery: it is the
   * task's acting member, or the delivery woke it for the task and its run
   * already reached T3, so the answer it owes is still its own. Publication
   * and the cause of a block decide it alike.
   */
  async function actsOn(c: Claim, task: Task) {
    const state = task.state;
    const assigned = actingMember(state.status, state.owner, state.reviewer);
    if (assigned?.kind === 'agent' && assigned.id === c.agentId) return true;
    const row = await get(c.id);
    const frozen =
      row.launch === null ? null : FrozenLaunch.parse(decode(row.launch));
    const fact = OutboxFact.parse(
      decode(
        (
          await q()
            .select()
            .from(s.communicationOutbox)
            .where(eq(s.communicationOutbox.id, c.eventId))
            .limit(1)
        )[0]?.fact ?? '',
      ),
    );
    const recipient =
      fact.kind !== 'task.changed'
        ? null
        : actingMember(fact.taskStatus, fact.owner, fact.reviewer);
    const intent = inboxIntent(c.agentId, c.id);
    const dispatched =
      frozen !== null &&
      (
        await q()
          .select({ id: s.executionOperations.id })
          .from(s.executionOperations)
          .where(
            and(
              eq(
                s.executionOperations.scope,
                executionScope(
                  frozen.execution.endpoint,
                  frozen.execution.environmentId,
                ),
              ),
              eq(s.executionOperations.actor, intent.actor),
              eq(s.executionOperations.operationKey, intent.operationKey),
              // Its own dispatch, whichever tool carried it: the first
              // delivery of a conversation launches, every later one sends.
              inArray(s.executionOperations.phase, [
                'dispatching',
                'uncertain',
                'known',
              ]),
            ),
          )
          .limit(1)
      )[0] !== undefined;
    return (
      fact.kind === 'task.changed' &&
      fact.taskId === task.id &&
      recipient?.kind === 'agent' &&
      recipient.id === c.agentId &&
      dispatched &&
      retainsExecutionResponsibility(task, c.agentId)
    );
  }
  async function authorized(c: Claim, p: Principal) {
    await owned(c);
    if (p.kind !== 'agent' || p.agentId !== c.agentId || p.teamId !== c.teamId)
      throw new DomainError('forbidden');
    const profile = await agents.authorize(
      p,
      c.teamId,
      c.agentId,
      'executions:write',
    );
    await agents.teamAccess(p, c.teamId, ...deliveryScopes(c.taskId !== null));
    const channel = await communication.channel(p, c.teamId, c.channelId);
    let task = null;
    if (c.taskId !== null) {
      task = await tasks.get(p, c.teamId, c.channelId, c.taskId);
      if (!(await actsOn(c, task))) throw new DomainError('forbidden');
    }
    return { profile, channel, task, principal: p };
  }
  /**
   * Every agent's work that never reached T3 and is past its lifetime
   * expires, whether a worker serves the agent or not; anything that may be
   * in T3 must stay reconcilable. A launch in flight is uncertain, not
   * ready. Runs under the claim lock.
   */
  async function expireUndispatched() {
    const expired = await q()
      .update(t)
      .set({
        state: 'expired',
        reason: 'undispatched-expiry',
        claimToken: null,
        leaseUntil: 0,
      })
      .where(
        and(
          eq(t.state, 'ready'),
          sql`NOT ${mayBeInT3}`,
          lte(t.expiresAt, dbNow),
          lte(t.leaseUntil, dbNow),
        ),
      )
      .returning();
    for (const row of expired)
      await history(Delivery.parse(row), 'undispatched-expiry');
  }
  async function update(
    c: Claim,
    data: {
      [K in keyof typeof t.$inferInsert]?: (typeof t.$inferInsert)[K] | SQL;
    },
  ) {
    if ((await q().update(t).set(data).where(fence(c))).count !== 1)
      throw new DomainError('conflict');
  }
  return {
    get,
    async find(eventId: string, agentId: AgentId) {
      z.uuid().parse(eventId);
      AgentId.parse(agentId);
      const row = (
        await q()
          .select()
          .from(t)
          .where(and(eq(t.eventId, eventId), eq(t.agentId, agentId)))
          .limit(1)
      )[0];
      return row === undefined ? undefined : Delivery.parse(row);
    },
    claim(agentIds: AgentId[]) {
      const ids = z.array(AgentId).min(1).parse(agentIds);
      return atomic(async () => {
        // Claims keep rules across rows (the hub's capacity, one active
        // delivery per agent), so they take turns, across processes: a lock
        // held until this transaction ends. Row locks alone (SKIP LOCKED)
        // would let two claims each see room and exceed the capacity.
        await q().execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`);
        await expireUndispatched();
        // Global capacity and per-agent oldest outstanding event serialize across independent processes.
        const capacity =
          (
            await q()
              .select({ count: sql<number>`count(*)::int` })
              .from(t)
              .where(gt(t.leaseUntil, dbNow))
              .limit(1)
          )[0]?.count ?? 0;
        if (capacity >= INBOX_CAPACITY) return undefined;
        const candidate = (
          await q()
            .select({ id: t.id })
            .from(t)
            .where(
              and(
                among(t.agentId, ids),
                inArray(t.state, ['ready', 'waiting', 'uncertain']),
                lte(t.nextAttempt, dbNow),
                lte(t.leaseUntil, dbNow),
                // One claim at a time per conversation (agent, channel and
                // topic), so its thread is started once and messages reach it
                // in order.
                // An operator can resume an older blocked row while a newer
                // one is leased; order alone does not exclude that owner.
                sql`NOT EXISTS (SELECT 1 FROM agent_inbox active WHERE active.agent_id = ${t.agentId} AND active.channel_id = ${t.channelId} AND active.topic_id IS NOT DISTINCT FROM ${t.topicId} AND active.lease_until > ${dbNow})`,
                // An older message not yet in T3 goes first. One already in
                // T3 holds nothing back: the next message steers its turn or
                // follows it in the same thread.
                sql`(${t.reference} IS NOT NULL OR NOT EXISTS (SELECT 1 FROM agent_inbox older WHERE older.agent_id = ${t.agentId} AND older.channel_id = ${t.channelId} AND older.topic_id IS NOT DISTINCT FROM ${t.topicId} AND older.position < ${t.position} AND older.state IN ('ready','waiting','uncertain') AND older.reference IS NULL))`,
              ),
            )
            .orderBy(asc(t.nextAttempt), asc(t.position))
            .limit(1)
        )[0];
        if (!candidate) return undefined;
        const row = (
          await q()
            .update(t)
            .set({
              generation: sql`${t.generation}+1`,
              claimToken: randomUUID(),
              leaseUntil: sql`${dbNow}+${INBOX_LEASE_MS}`,
              attempts: sql`least(${t.attempts}+1,1000000)`,
            })
            .where(and(eq(t.id, candidate.id), lte(t.leaseUntil, dbNow)))
            .returning()
        )[0];
        // A claim is a lease, not a transition: nothing a person sees changes.
        return Claim.parse(row);
      });
    },
    context(c: Claim, p: Principal) {
      return atomic(async () => {
        const { profile, channel, task } = await authorized(c, p);
        const raw = (
          await q()
            .select()
            .from(s.communicationOutbox)
            .where(eq(s.communicationOutbox.id, c.eventId))
            .limit(1)
        )[0];
        const fact = OutboxFact.parse(decode(raw?.fact ?? ''));
        if (fact.teamId !== c.teamId || fact.channelId !== c.channelId)
          throw new DomainError('not-found');
        const message =
          c.messageId === null
            ? null
            : await communication.message(
                p,
                c.teamId,
                c.channelId,
                c.messageId,
              );
        const topic =
          c.topicId === null
            ? null
            : await communication.topic(p, c.teamId, c.channelId, c.topicId);
        return {
          profile,
          context: SourceContext.parse({
            channelId: c.channelId,
            channelName: channel.name,
            author: await authorName(fact.author),
            topic: topic === null ? null : topic.title,
            message:
              message === null
                ? null
                : {
                    body: clip(message.body, 4000),
                    truncated: message.body.length > 4000,
                  },
            task:
              task === null
                ? null
                : {
                    id: task.id,
                    change:
                      fact.kind === 'task.changed' ? fact.taskAction : null,
                    title: task.title,
                    description: clip(task.description, 2000),
                    status: task.state.status,
                    criteria: task.criteria
                      .slice(0, 5)
                      .map((v) => clip(v, 200)),
                    truncated:
                      task.description.length > 2000 ||
                      task.criteria.length > 5 ||
                      task.criteria.some((v) => v.length > 200),
                  },
            memoryLocation: profile.memoryLocation,
          }),
        };
      });
    },
    freeze(c: Claim, p: Principal, launch: z.infer<typeof FrozenLaunch>) {
      return atomic(async () => {
        await authorized(c, p);
        const value = FrozenLaunch.parse(launch);
        if (p.kind !== 'agent' || value.grantId !== p.grantId)
          throw new DomainError('forbidden');
        const row = await get(c.id);
        if (row.launch !== null) {
          const frozen = FrozenLaunch.parse(decode(row.launch));
          const authority =
            frozen.grantId === p.grantId &&
            JSON.stringify(frozen.execution) ===
              JSON.stringify(value.execution);
          const model =
            JSON.stringify(frozen.input.model) ===
            JSON.stringify(value.input.model);
          const conversation =
            JSON.stringify(frozen.conversation) ===
              JSON.stringify(value.conversation) &&
            JSON.stringify(frozen.input.target) ===
              JSON.stringify(value.input.target);
          if (authority && model && conversation) return frozen;
          // A different grant or T3 authority may never replay an operation
          // that could exist natively, and a run that may exist keeps the
          // model and thread it started with. One that provably never reached
          // T3 (nothing journaled: the journal is written before dispatch) is
          // frozen again as things are now, e.g. after someone reconnects T3
          // with the access the first attempt lacked, chooses a new model, or
          // another message started the conversation's thread meanwhile.
          const intent = inboxIntent(c.agentId, c.id);
          const journaled = (
            await q()
              .select({ id: s.executionOperations.id })
              .from(s.executionOperations)
              .where(
                and(
                  eq(s.executionOperations.actor, intent.actor),
                  eq(s.executionOperations.operationKey, intent.operationKey),
                ),
              )
              .limit(1)
          )[0];
          if (
            row.operationId !== null ||
            row.reference !== null ||
            journaled !== undefined
          ) {
            if (authority) return frozen;
            throw new DomainError('forbidden');
          }
          await update(c, {
            launch: JSON.stringify(value),
            reason: 'launch-refrozen',
          });
          await history(await get(c.id), 'launch-refrozen');
          return value;
        }
        await update(c, {
          launch: JSON.stringify(value),
          reason: 'launch-frozen',
        });
        await history(await get(c.id), 'launch-frozen');
        return value;
      });
    },
    /**
     * The conversation's thread is gone from T3, so this delivery starts a
     * new one. Only a delivery not in T3 can; the journal lets its key carry
     * the new thread only because T3 refused the send.
     */
    restart(c: Claim, p: Principal, launch: z.infer<typeof FrozenLaunch>) {
      return atomic(async () => {
        await authorized(c, p);
        const value = FrozenLaunch.parse(launch);
        const row = await get(c.id);
        if (row.launch === null || row.reference !== null)
          throw new DomainError('conflict');
        const frozen = FrozenLaunch.parse(decode(row.launch));
        if (
          p.kind !== 'agent' ||
          value.grantId !== p.grantId ||
          frozen.grantId !== p.grantId ||
          value.conversation !== undefined ||
          JSON.stringify(frozen.execution) !== JSON.stringify(value.execution)
        )
          throw new DomainError('forbidden');
        await update(c, {
          launch: JSON.stringify(value),
          reason: 'launch-refrozen',
        });
        await history(await get(c.id), 'launch-refrozen');
        return value;
      });
    },
    /**
     * The agent's conversation in the delivery's topic, or in its channel
     * outside topics: the thread the latest of its other deliveries there
     * reached, the T3 authority and
     * model it runs under, and the position after the last answer published
     * from it. Null before the agent's first message in the channel.
     */
    async conversation(c: Claim) {
      return atomic(async () => {
        await owned(c);
        const latest = (
          await q()
            .select({ launch: t.launch, reference: t.reference })
            .from(t)
            .where(
              and(
                eq(t.agentId, c.agentId),
                eq(t.channelId, c.channelId),
                sql`${t.topicId} IS NOT DISTINCT FROM ${c.topicId}`,
                sql`${t.id} <> ${c.id}`,
                sql`${t.reference} IS NOT NULL`,
                sql`${t.launch} IS NOT NULL`,
              ),
            )
            .orderBy(desc(t.position))
            .limit(1)
        )[0];
        if (!latest?.launch || !latest.reference) return null;
        const frozen = FrozenLaunch.parse(decode(latest.launch));
        const thread = Reference.parse(decode(latest.reference)).threadId;
        // Recent answers only: the furthest published item in this thread.
        const answers = await q()
          .select({ result: s.inboxResults.result })
          .from(s.inboxResults)
          .innerJoin(t, eq(t.id, s.inboxResults.deliveryId))
          .where(
            and(
              eq(t.agentId, c.agentId),
              eq(t.channelId, c.channelId),
              sql`${t.topicId} IS NOT DISTINCT FROM ${c.topicId}`,
            ),
          )
          .orderBy(desc(t.position))
          .limit(20);
        const positions = answers.flatMap(({ result }) => {
          const outcome = PublishedOutcome.parse(decode(result));
          return 'kind' in outcome ||
            outcome.reference.threadId !== thread ||
            outcome.position === undefined
            ? []
            : [outcome.position];
        });
        return {
          execution: frozen.execution,
          model: frozen.input.model,
          mode: frozen.input.mode,
          target: frozen.input.target,
          conversation: {
            threadId: thread,
            afterPosition: positions.length ? Math.max(...positions) : null,
          },
        };
      });
    },
    /**
     * The delivery's channel's folder in the space: `named` the first time,
     * the same folder ever after.
     */
    async space(c: Claim, named: string) {
      return atomic(async () => {
        await owned(c);
        await q()
          .insert(s.channelSpaces)
          .values({
            channelId: c.channelId,
            teamId: c.teamId,
            directory: named,
          })
          .onConflictDoNothing();
        const row = (
          await q()
            .select({ directory: s.channelSpaces.directory })
            .from(s.channelSpaces)
            .where(eq(s.channelSpaces.channelId, c.channelId))
            .limit(1)
        )[0];
        if (!row) throw new DomainError('conflict');
        return row.directory;
      });
    },
    /**
     * The worker is about to call T3, under its claim: from here the run may
     * exist, so the delivery is uncertain until the launch's reply is
     * remembered, and no longer expires. A worker whose claim is gone
     * learns it here, before T3 is called.
     */
    async launching(c: Claim) {
      return atomic(async () => {
        // A person stopped it before it reached T3: nothing is sent.
        const stopped = await q()
          .update(t)
          .set({
            state: 'expired',
            reason: 'stopped',
            claimToken: null,
            leaseUntil: 0,
          })
          .where(
            and(
              fence(c),
              sql`${t.stopRequestedAt} IS NOT NULL`,
              sql`NOT ${mayBeInT3}`,
            ),
          );
        if (stopped.count === 1) {
          await history(await get(c.id), 'stopped');
          return false;
        }
        await update(c, {
          state: 'uncertain',
          reason: 'native-launch-pending',
        });
        await history(await get(c.id), 'native-launch-pending');
        return true;
      });
    },
    /** `steered`: T3 said the message steered a run already under way. */
    async remember(
      c: Claim,
      reference: Reference | { operationId: string },
      steered = false,
    ) {
      await atomic(async () => {
        await owned(c);
        const row = await get(c.id);
        if ('operationId' in reference) {
          const id = z.string().min(1).max(256).parse(reference.operationId);
          if (row.operationId !== null && row.operationId !== id)
            throw new DomainError('conflict');
          await update(c, { operationId: id });
        } else {
          const ref = Reference.parse(reference);
          if (
            ref.runId === undefined ||
            (row.reference !== null && row.reference !== JSON.stringify(ref))
          )
            throw new DomainError('conflict');
          await update(c, {
            reference: JSON.stringify(ref),
            ...(row.reference === null ? { steered } : {}),
          });
        }
        await history(await get(c.id), 'execution-correlated');
      });
    },
    /**
     * The run its message steered stopped without answering it, so the
     * message was sent again as a turn of its own: the delivery follows that
     * run now. Only once, and only for a steered message.
     */
    async resent(c: Claim, reference: Reference) {
      await atomic(async () => {
        await owned(c);
        const row = await get(c.id);
        const ref = Reference.parse(reference);
        if (!row.steered || row.reference === null || ref.runId === undefined)
          throw new DomainError('conflict');
        await update(c, {
          reference: JSON.stringify(ref),
          steered: false,
          reason: 'message-resent',
        });
        await history(await get(c.id), 'message-resent');
      });
    },
    async defer(
      c: Claim,
      state: 'ready' | 'waiting' | 'uncertain' | 'blocked',
      reason: string,
    ) {
      await atomic(async () => {
        z.enum(['ready', 'waiting', 'uncertain', 'blocked']).parse(state);
        z.string()
          .regex(/^[a-z-]{1,80}$/)
          .parse(reason);
        // A run under way is looked at on its own cadence, by how long it
        // has been waiting; everything else backs off by failed attempts.
        let delay = retryDelay(c.attempts);
        if (state === 'waiting') {
          const last = await recorded(c.id);
          delay = waitDelay(last?.state === 'waiting' ? last.age : 0);
        }
        await update(c, {
          state,
          reason,
          claimToken: null,
          leaseUntil: 0,
          nextAttempt: sql`${dbNow}+${delay}`,
        });
        await history(await get(c.id), reason);
      });
    },
    ack(c: Claim, p: Principal, input: PublishedOutcome) {
      return atomic(async () => {
        const { task } = await authorized(c, p);
        const result = PublishedOutcome.parse(input);
        const row = await get(c.id);
        if (
          row.reference !== JSON.stringify(result.reference) ||
          row.launch === null
        )
          throw new DomainError('conflict');
        const frozen = FrozenLaunch.parse(decode(row.launch));
        if (p.kind !== 'agent' || frozen.grantId !== p.grantId)
          throw new DomainError('forbidden');
        const publicationReason: DeliveryReason =
          'kind' in result
            ? 'native-terminal-notice-published'
            : 'assistant-result-published';
        // A message that steered a running turn is answered by that run's
        // reply, which is posted once: the first delivery of the run to
        // publish posts it, and the others point to it.
        const answered = (
          await q()
            .select({ messageId: t.resultMessageId })
            .from(t)
            .where(
              and(
                eq(t.agentId, c.agentId),
                eq(t.channelId, c.channelId),
                eq(t.state, 'acked'),
                eq(t.reference, row.reference),
                sql`${t.id} <> ${c.id}`,
              ),
            )
            .limit(1)
        )[0]?.messageId;
        if (answered) {
          await update(c, {
            state: 'acked',
            resultMessageId: answered,
            claimToken: null,
            leaseUntil: 0,
            reason: publicationReason,
          });
          await history(await get(c.id), publicationReason);
          return await communication.message(
            p,
            c.teamId,
            c.channelId,
            MessageId.parse(answered),
          );
        }
        // These links and the actual message/outbox either commit together with ACK, or all roll back.
        // The execution API can associate this Run before Inbox publication.
        // Reuse only this agent's exact execution, preserving immutable provenance.
        const correlation =
          (
            await q()
              .select({ id: s.agentCorrelations.id })
              .from(s.agentCorrelations)
              .where(
                and(
                  eq(s.agentCorrelations.teamId, c.teamId),
                  eq(s.agentCorrelations.agentId, c.agentId),
                  eq(
                    s.agentCorrelations.referenceKey,
                    referenceKey(result.reference),
                  ),
                ),
              )
              .limit(1)
          )[0] ??
          (await agents.correlate(p, c.teamId, c.agentId, {
            reference: result.reference,
            providerSessionId: null,
            invocationId: c.id,
          }));
        await agents.runtimeEvent(
          p,
          c.teamId,
          c.agentId,
          correlation.id,
          result.state,
        );
        // Team MCP may already have linked this exact Run. Reuse that
        // immutable evidence under the same authorization and ACK fence.
        const taskLink =
          task === null
            ? null
            : ((
                await q()
                  .select({ id: s.taskExecutions.id })
                  .from(s.taskExecutions)
                  .where(
                    and(
                      eq(s.taskExecutions.taskId, task.id),
                      eq(
                        s.taskExecutions.referenceKey,
                        referenceKey(result.reference),
                      ),
                    ),
                  )
                  .limit(1)
              )[0] ??
              (await tasks.recordInboxExecution(
                p,
                c.teamId,
                c.channelId,
                task.id,
                result.reference,
              )));
        // The message is the answer only. Where it came from (run, model,
        // state) is kept in inbox_results and shown beside it, not in it.
        const body =
          'kind' in result
            ? result.state === 'failed'
              ? 'The run in T3 failed before writing a reply.'
              : 'The run in T3 was stopped before writing a reply.'
            : result.text;
        const message = await communication.post(p, c.teamId, c.channelId, {
          operationKey: 'inbox-result:' + c.id,
          body,
          topicId: c.topicId,
          mentions: [],
          sourceMessageId: c.messageId,
          sourceEventId: c.eventId,
        });
        await q()
          .insert(s.inboxResults)
          .values({
            deliveryId: c.id,
            messageId: message.id,
            correlationId: correlation.id,
            taskLinkId: taskLink?.id ?? null,
            result: JSON.stringify(result),
          });
        await update(c, {
          state: 'acked',
          resultMessageId: message.id,
          claimToken: null,
          leaseUntil: 0,
          reason: publicationReason,
        });
        await history(await get(c.id), publicationReason);
        return message;
      });
    },
    /**
     * The first Kinmesh precondition a delivery no longer meets, so whoever
     * can fix it is told what to fix. Read-only; never grants authority.
     */
    async blockedCause(c: Claim, token: () => string): Promise<BlockedReason> {
      const agent = (
        await q()
          .select({ lifecycle: s.agents.lifecycle })
          .from(s.agents)
          .where(and(eq(s.agents.id, c.agentId), eq(s.agents.teamId, c.teamId)))
          .limit(1)
      )[0];
      if (agent?.lifecycle !== 'active') return 'agent-disabled';
      let p: Principal;
      try {
        p = await agents.resolveToken(token());
      } catch {
        return 'credential-invalid';
      }
      if (
        p.kind !== 'agent' ||
        p.agentId !== c.agentId ||
        !deliveryScopes(c.taskId !== null).every((scope) =>
          p.scopes.includes(scope),
        )
      )
        return 'credential-invalid';
      const joined = (
        await q()
          .select({ state: s.channelParticipants.state })
          .from(s.channelParticipants)
          .where(
            and(
              eq(s.channelParticipants.channelId, c.channelId),
              eq(
                s.channelParticipants.memberKey,
                memberKey({ kind: 'agent', id: c.agentId }),
              ),
            ),
          )
          .limit(1)
      )[0];
      if (joined?.state !== 'joined') return 'not-in-channel';
      if (c.taskId !== null)
        try {
          const task = await tasks.get(p, c.teamId, c.channelId, c.taskId);
          if (!(await actsOn(c, task))) return 'not-assigned';
        } catch {
          // A task the agent can no longer read explains nothing more here.
        }
      return 'authority-or-contract-blocked';
    },
    // Operator-local recovery; people use resumeByPerson. Neither mints a new native operation key.
    async resume(id: string) {
      await atomic(async () => {
        await reopen(id, 'operator-resume');
      });
    },
    /**
     * Recovery from the workspace: the same resume, by any person of the
     * team, for a delivery in a channel they can read. Retrying the same
     * operation key replays.
     */
    resumeByPerson(
      p: Principal,
      teamId: string,
      id: string,
      operationKey: string,
    ) {
      return atomic(async () => {
        if (p.kind !== 'human') throw new DomainError('forbidden');
        await agents.person(p, TeamId.parse(teamId));
        const row = (
          await q()
            .select()
            .from(t)
            .where(eq(t.id, z.uuid().parse(id)))
            .limit(1)
        )[0];
        if (row?.teamId !== teamId) throw new DomainError('not-found');
        await communication.channel(
          p,
          TeamId.parse(teamId),
          ChannelId.parse(row.channelId),
        );
        return receipt(
          'inbox-resume:' + teamId,
          operationKey,
          { id },
          z.strictObject({ id: z.uuid() }),
          async () => {
            await reopen(id, 'owner-resume');
            return { id };
          },
        );
      });
    },
    /**
     * Expires undispatched work past its lifetime for every agent, also those
     * no worker serves, whose work no claim ever looks at.
     */
    expire() {
      return atomic(async () => {
        await q().execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`);
        await expireUndispatched();
      });
    },
    /**
     * A person ends a delivery, by the same rule as resuming one: any person
     * of the team who can read its channel. One that nothing of reached T3
     * ends at once; one whose run may be in T3 is marked, and the worker
     * interrupts the run and posts how it ended. One already finished stays
     * as it is. A blocked one that may be in T3 can't be reached from here
     * (a conflict). Retrying the same operation key replays.
     */
    stopByPerson(
      p: Principal,
      teamId: string,
      id: string,
      operationKey: string,
    ) {
      return atomic(async () => {
        if (p.kind !== 'human') throw new DomainError('forbidden');
        await agents.person(p, TeamId.parse(teamId));
        const found = (
          await q()
            .select()
            .from(t)
            .where(eq(t.id, z.uuid().parse(id)))
            .limit(1)
        )[0];
        if (found?.teamId !== teamId) throw new DomainError('not-found');
        await communication.channel(
          p,
          TeamId.parse(teamId),
          ChannelId.parse(found.channelId),
        );
        return receipt(
          'inbox-stop:' + teamId,
          operationKey,
          { id },
          z.strictObject({ id: z.uuid() }),
          async () => {
            const ended = await q()
              .update(t)
              .set({
                state: 'expired',
                reason: 'stopped',
                stopRequestedAt: sql`coalesce(${t.stopRequestedAt}, ${dbNow})`,
                claimToken: null,
                leaseUntil: 0,
              })
              .where(
                and(
                  eq(t.id, id),
                  inArray(t.state, [
                    'ready',
                    'waiting',
                    'uncertain',
                    'blocked',
                  ]),
                  lte(t.leaseUntil, dbNow),
                  sql`NOT ${mayBeInT3}`,
                ),
              );
            const row = await get(id);
            if (ended.count === 1) await history(row, 'stopped');
            else if (row.state === 'blocked') throw new DomainError('conflict');
            else if (
              row.state !== 'acked' &&
              row.state !== 'expired' &&
              row.stopRequestedAt === null
            ) {
              await q()
                .update(t)
                .set({
                  stopRequestedAt: dbNow,
                  reason: 'stop-requested',
                  nextAttempt: dbNow,
                })
                .where(and(eq(t.id, id), sql`${t.stopRequestedAt} IS NULL`));
              await history(await get(id), 'stop-requested');
            }
            return { id };
          },
        );
      });
    },
    /** Liveness only, never authority: unknown or foreign agent IDs are ignored. */
    async heartbeat(agentIds: string[]) {
      const ids = z.array(AgentId).parse(agentIds);
      if (ids.length === 0) return;
      await atomic(async () => {
        for (const agent of await q()
          .select({ id: s.agents.id, teamId: s.agents.teamId })
          .from(s.agents)
          .where(among(s.agents.id, ids)))
          await q()
            .insert(s.inboxBindings)
            .values({
              agentId: agent.id,
              teamId: agent.teamId,
              lastSeenAt: dbNow,
            })
            .onConflictDoUpdate({
              target: s.inboxBindings.agentId,
              set: { lastSeenAt: dbNow },
            });
      });
    },
    /** A clean stop withdraws liveness at once instead of waiting for it to go stale. */
    async release(agentIds: string[]) {
      const ids = z.array(AgentId).parse(agentIds);
      if (ids.length === 0) return;
      await q()
        .delete(s.inboxBindings)
        .where(among(s.inboxBindings.agentId, ids));
    },
    /** How many deliveries are in each state, across the hub. */
    async countsByState() {
      return await q()
        .select({ state: t.state, count: sql<number>`count(*)::int` })
        .from(t)
        .groupBy(t.state);
    },
    /** Agents whose worker was seen within the liveness window, in any team. */
    async awake(now: number) {
      return (
        await q()
          .select({ agentId: s.inboxBindings.agentId })
          .from(s.inboxBindings)
          .where(gte(s.inboxBindings.lastSeenAt, now - INBOX_LIVENESS_MS))
          .orderBy(s.inboxBindings.agentId)
      ).map((row) => row.agentId);
    },
    async status() {
      return (
        await q()
          .select({ state: t.state, count: sql<number>`count(*)::int` })
          .from(t)
          .groupBy(t.state)
      ).map((r) => ({ state: InboxState.parse(r.state), count: r.count }));
    },
  };
}
