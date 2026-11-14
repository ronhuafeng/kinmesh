import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { communicationRepository } from './communication.js';
import type { taskRepository } from './tasks.js';
import { referenceKey, transactional } from './transactional.js';
import { dbNow, type Database } from './database.js';
import { executionScope } from './operations.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import { AgentId, ChannelId, TeamId } from '../domain/contracts.js';
import { OutboxFact, memberKey } from '../domain/communication.js';
import {
  Claim,
  Delivery,
  FrozenLaunch,
  INBOX_CAPACITY,
  INBOX_LEASE_MS,
  INBOX_LIVENESS_MS,
  SourceContext,
  PublishedOutcome,
  retryDelay,
  InboxState,
  deliveryScopes,
  inboxIntent,
  type BlockedReason,
  type DeliveryReason,
} from '../domain/inbox.js';
import { Reference } from '../domain/execution.js';
import {
  actingMember,
  retainsExecutionResponsibility,
} from '../domain/tasks.js';

const decode = (value: string): unknown => JSON.parse(value);
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
      throw new IdentityError(409);
  }
  async function history(row: Delivery, reason: string) {
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
  /** Blocked → retry with the frozen intent; never a new native operation key. */
  async function reopen(id: string, reason: DeliveryReason) {
    const row = await get(id);
    if (row.state !== 'blocked') throw new IdentityError(409);
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
    if (changed.count !== 1) throw new IdentityError(409);
    await history(await get(id), reason);
  }
  async function authorized(c: Claim, p: Principal) {
    await owned(c);
    if (p.kind !== 'agent' || p.agentId !== c.agentId || p.teamId !== c.teamId)
      throw new IdentityError(403);
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
      const state = task.state;
      const assigned = actingMember(state.status, state.owner, state.reviewer);
      if (assigned?.kind !== 'agent' || assigned.id !== c.agentId) {
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
                  eq(s.executionOperations.tool, 't3_thread_launch'),
                  inArray(s.executionOperations.phase, [
                    'dispatching',
                    'uncertain',
                    'known',
                  ]),
                ),
              )
              .limit(1)
          )[0] !== undefined;
        if (
          fact.kind !== 'task.changed' ||
          fact.taskId !== task.id ||
          recipient?.kind !== 'agent' ||
          recipient.id !== c.agentId ||
          !dispatched ||
          !retainsExecutionResponsibility(task, c.agentId)
        )
          throw new IdentityError(403);
      }
    }
    return { profile, channel, task, principal: p };
  }
  async function update(
    c: Claim,
    data: {
      [K in keyof typeof t.$inferInsert]?: (typeof t.$inferInsert)[K] | SQL;
    },
  ) {
    if ((await q().update(t).set(data).where(fence(c))).count !== 1)
      throw new IdentityError(409);
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
      const ids = z.array(AgentId).min(1).max(32).parse(agentIds);
      return atomic(async () => {
        // Claims keep rules across rows (the hub's capacity, one active
        // delivery per agent), so they take turns, across processes: a lock
        // held until this transaction ends. Row locks alone (SKIP LOCKED)
        // would let two claims each see room and exceed the capacity.
        await q().execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`);
        // Expire only never-dispatched work. Frozen launches/uncertainty must remain reconcilable.
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
              inArray(t.agentId, ids),
              eq(t.state, 'ready'),
              sql`${t.launch} IS NULL`,
              lte(t.expiresAt, dbNow),
              lte(t.leaseUntil, dbNow),
            ),
          )
          .returning();
        for (const row of expired)
          await history(Delivery.parse(row), 'undispatched-expiry');
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
                inArray(t.agentId, ids),
                inArray(t.state, ['ready', 'waiting', 'uncertain']),
                lte(t.nextAttempt, dbNow),
                lte(t.leaseUntil, dbNow),
                // An operator can resume an older blocked row while a newer row is leased.
                // Oldest-outstanding order alone does not exclude that live same-agent owner.
                sql`NOT EXISTS (SELECT 1 FROM agent_inbox active WHERE active.agent_id = ${t.agentId} AND active.lease_until > ${dbNow})`,
                sql`NOT EXISTS (SELECT 1 FROM agent_inbox older WHERE older.agent_id = ${t.agentId} AND older.position < ${t.position} AND older.state IN ('ready','waiting','uncertain'))`,
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
        const claim = Claim.parse(row);
        await history(claim, 'claimed');
        return claim;
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
          throw new IdentityError(404);
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
            deliveryId: c.id,
            eventId: c.eventId,
            rootId: c.rootId,
            depth: c.depth,
            agentId: c.agentId,
            teamId: c.teamId,
            channelId: c.channelId,
            channelName: channel.name,
            author: fact.author,
            topic: topic === null ? null : { id: topic.id, title: topic.title },
            message:
              message === null
                ? null
                : {
                    id: message.id,
                    body: message.body.slice(0, 4000),
                    truncated: message.body.length > 4000,
                  },
            task:
              task === null
                ? null
                : {
                    id: task.id,
                    title: task.title,
                    description: task.description.slice(0, 2000),
                    status: task.state.status,
                    version: task.version,
                    criteria: task.criteria
                      .slice(0, 5)
                      .map((v) => v.slice(0, 200)),
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
          throw new IdentityError(403);
        const row = await get(c.id);
        if (row.launch !== null) {
          const frozen = FrozenLaunch.parse(decode(row.launch));
          if (
            frozen.grantId === p.grantId &&
            JSON.stringify(frozen.execution) === JSON.stringify(value.execution)
          )
            return frozen;
          // A different grant or T3 authority may never replay an operation
          // that could exist natively. One that provably never reached T3
          // (nothing journaled: the journal is written before dispatch) is
          // frozen again under the current authority, e.g. after the owner
          // reconnects T3 with the access the first attempt lacked.
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
          )
            throw new IdentityError(403);
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
    async remember(c: Claim, reference: Reference | { operationId: string }) {
      await atomic(async () => {
        await owned(c);
        const row = await get(c.id);
        if ('operationId' in reference) {
          const id = z.string().min(1).max(256).parse(reference.operationId);
          if (row.operationId !== null && row.operationId !== id)
            throw new IdentityError(409);
          await update(c, { operationId: id });
        } else {
          const ref = Reference.parse(reference);
          if (
            ref.runId === undefined ||
            (row.reference !== null && row.reference !== JSON.stringify(ref))
          )
            throw new IdentityError(409);
          await update(c, { reference: JSON.stringify(ref) });
        }
        await history(await get(c.id), 'execution-correlated');
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
        await update(c, {
          state,
          reason,
          claimToken: null,
          leaseUntil: 0,
          nextAttempt: sql`${dbNow}+${retryDelay(c.attempts)}`,
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
          throw new IdentityError(409);
        const frozen = FrozenLaunch.parse(decode(row.launch));
        if (p.kind !== 'agent' || frozen.grantId !== p.grantId)
          throw new IdentityError(403);
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
        const publicationReason: DeliveryReason =
          'kind' in result
            ? 'native-terminal-notice-published'
            : 'assistant-result-published';
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
      return c.taskId !== null
        ? 'not-assigned'
        : 'authority-or-contract-blocked';
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
        if (p.kind !== 'human') throw new IdentityError(403);
        await agents.person(p, TeamId.parse(teamId));
        const row = (
          await q()
            .select()
            .from(t)
            .where(eq(t.id, z.uuid().parse(id)))
            .limit(1)
        )[0];
        if (row?.teamId !== teamId) throw new IdentityError(404);
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
    /** Liveness only, never authority: unknown or foreign agent IDs are ignored. */
    async heartbeat(agentIds: string[]) {
      const ids = z.array(AgentId).parse(agentIds);
      if (ids.length === 0) return;
      await atomic(async () => {
        for (const agent of await q()
          .select({ id: s.agents.id, teamId: s.agents.teamId })
          .from(s.agents)
          .where(inArray(s.agents.id, ids)))
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
        .where(inArray(s.inboxBindings.agentId, ids));
    },
    /**
     * Read-only delivery view for a channel page: mention deliveries of the
     * given messages, deliveries answered by them, and task wakes. Callers
     * must already have authorized channel access. Worker internals (claim,
     * launch, operation, reference, counters) never leave this method.
     */
    async deliveriesFor(
      teamId: string,
      channelId: string,
      messageIds: string[],
      taskIds: string[],
    ) {
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
    },
    /**
     * Blocked deliveries a person caused — the root of what woke the agent
     * is theirs — in channels they are joined to, newest first. Anyone may
     * resume one; each person is asked only about their own. The
     * projection is allow-listed.
     */
    async blockedIn(teamId: string, humanId: string) {
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
    },
    /** How many deliveries are in each state, across the hub. */
    async countsByState() {
      return await q()
        .select({ state: t.state, count: sql<number>`count(*)::int` })
        .from(t)
        .groupBy(t.state);
    },
    /** Deliveries still waiting for a worker to pick them up, per agent. */
    async queuedPerAgent(teamId: string) {
      return await q()
        .select({ agentId: t.agentId, count: sql<number>`count(*)::int` })
        .from(t)
        .where(and(eq(t.teamId, teamId), eq(t.state, 'ready')))
        .groupBy(t.agentId);
    },
    /**
     * Where each visible agent reply came from: the run's outcome, the model
     * it ran on and its T3 identifiers. Allow-listed; no prompts or tokens.
     */
    async repliesFor(teamId: string, channelId: string, messageIds: string[]) {
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
    },
    /** Last worker heartbeat per agent of one team (milliseconds since epoch). */
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
    async liveness(teamId: string) {
      return await q()
        .select({
          agentId: s.inboxBindings.agentId,
          lastSeenAt: s.inboxBindings.lastSeenAt,
        })
        .from(s.inboxBindings)
        .where(eq(s.inboxBindings.teamId, teamId));
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
