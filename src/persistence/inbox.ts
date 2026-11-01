import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { communicationRepository } from './communication.js';
import type { taskRepository } from './tasks.js';
import { fingerprint, transactional } from './transactional.js';
import { sqliteNow } from './inbox-enqueue.js';
import { IdentityError, type Principal, type Scope } from '../domain/agents.js';
import { AgentId, ChannelId, TeamId } from '../domain/contracts.js';
import { OutboxFact, memberKey } from '../domain/communication.js';
import {
  Claim,
  Delivery,
  FrozenLaunch,
  INBOX_CAPACITY,
  INBOX_LEASE_MS,
  SourceContext,
  PublishedOutcome,
  retryDelay,
  InboxState,
  type BlockedReason,
} from '../domain/inbox.js';
import { Reference } from '../domain/execution.js';
import { retainsExecutionResponsibility } from '../domain/tasks.js';

const decode = (value: string): unknown => JSON.parse(value);
export function inboxRepository(
  db: BetterSQLite3Database<typeof s>,
  agents: ReturnType<typeof agentRepository>,
  communication: ReturnType<typeof communicationRepository>,
  tasks: ReturnType<typeof taskRepository>,
) {
  const { atomic, receipt } = transactional(db);
  const t = s.agentInbox;
  /** First and last recorded transition, for "queued 2 h ago" copy. */
  function withTimes<R extends { id: string; state: string }>(rows: R[]) {
    if (rows.length === 0) return [];
    const times = new Map(
      db
        .select({
          id: s.inboxHistory.deliveryId,
          first: sql<number>`min(${s.inboxHistory.createdAt})`,
          last: sql<number>`max(${s.inboxHistory.createdAt})`,
        })
        .from(s.inboxHistory)
        .where(
          inArray(
            s.inboxHistory.deliveryId,
            rows.map((r) => r.id),
          ),
        )
        .groupBy(s.inboxHistory.deliveryId)
        .all()
        .map((r) => [r.id, r]),
    );
    return rows.map((r) => ({
      ...r,
      state: InboxState.parse(r.state),
      queuedAt: times.get(r.id)?.first ?? null,
      updatedAt: times.get(r.id)?.last ?? null,
    }));
  }
  function get(id: string) {
    z.uuid().parse(id);
    return Delivery.parse(db.select().from(t).where(eq(t.id, id)).get());
  }
  function fence(c: Claim) {
    Claim.parse(c);
    return and(
      eq(t.id, c.id),
      eq(t.generation, c.generation),
      eq(t.claimToken, c.claimToken),
      gt(t.leaseUntil, sqliteNow),
    );
  }
  function owned(c: Claim) {
    if (!db.select({ id: t.id }).from(t).where(fence(c)).get())
      throw new IdentityError(409);
  }
  function history(row: Delivery, reason: string) {
    const count =
      db
        .select({ n: sql<number>`count(*)` })
        .from(s.inboxHistory)
        .where(eq(s.inboxHistory.deliveryId, row.id))
        .get()?.n ?? 0;
    // Keep bounded diagnostic snapshots plus a reserved final ACK; immutable source/audit/result is retained.
    if (count >= (row.state === 'acked' ? 128 : 127)) return;
    db.insert(s.inboxHistory)
      .values({
        deliveryId: row.id,
        generation: row.generation,
        state: row.state,
        reason,
        createdAt: sqliteNow,
      })
      .run();
  }
  /** Blocked → retry with the frozen intent; never a new native operation key. */
  function reopen(id: string, reason: string) {
    const row = get(id);
    if (row.state !== 'blocked') throw new IdentityError(409);
    const changed = db
      .update(t)
      .set({
        state: row.reference === null ? 'uncertain' : 'waiting',
        reason,
        nextAttempt: sqliteNow,
      })
      .where(
        and(eq(t.id, id), eq(t.state, 'blocked'), lte(t.leaseUntil, sqliteNow)),
      )
      .run();
    if (changed.changes !== 1) throw new IdentityError(409);
    history(get(id), reason);
  }
  function authorized(c: Claim, p: Principal) {
    owned(c);
    if (p.kind !== 'agent' || p.agentId !== c.agentId || p.teamId !== c.teamId)
      throw new IdentityError(403);
    const profile = agents.authorize(
      p,
      c.teamId,
      c.agentId,
      'executions:write',
    );
    agents.teamAccess(p, c.teamId, 'channels:write');
    const channel = communication.channel(p, c.teamId, c.channelId);
    let task = null;
    if (c.taskId !== null) {
      agents.teamAccess(p, c.teamId, 'tasks:write');
      task = tasks.get(p, c.teamId, c.channelId, c.taskId);
      const state = task.state;
      const assigned =
        state.status === 'review-requested'
          ? state.reviewer
          : ['in-progress', 'rework-requested'].includes(state.status)
            ? state.owner
            : null;
      if (assigned?.kind !== 'agent' || assigned.id !== c.agentId) {
        const row = get(c.id);
        const frozen =
          row.launch === null ? null : FrozenLaunch.parse(decode(row.launch));
        const fact = OutboxFact.parse(
          decode(
            db
              .select()
              .from(s.communicationOutbox)
              .where(eq(s.communicationOutbox.id, c.eventId))
              .get()?.fact ?? '',
          ),
        );
        const recipient =
          fact.kind !== 'task.changed'
            ? null
            : fact.taskStatus === 'review-requested'
              ? fact.reviewer
              : ['in-progress', 'rework-requested'].includes(fact.taskStatus)
                ? fact.owner
                : null;
        const dispatched =
          frozen !== null &&
          db
            .select({ id: s.executionOperations.id })
            .from(s.executionOperations)
            .where(
              and(
                eq(
                  s.executionOperations.scope,
                  fingerprint([
                    frozen.execution.endpoint,
                    frozen.execution.environmentId,
                  ]),
                ),
                eq(s.executionOperations.actor, 'inbox-agent:' + c.agentId),
                eq(s.executionOperations.operationKey, 'inbox:' + c.id),
                eq(s.executionOperations.tool, 't3_thread_launch'),
                inArray(s.executionOperations.phase, [
                  'dispatching',
                  'uncertain',
                  'known',
                ]),
              ),
            )
            .get() !== undefined;
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
  function update(
    c: Claim,
    data: {
      [K in keyof typeof t.$inferInsert]?: (typeof t.$inferInsert)[K] | SQL;
    },
  ) {
    if (db.update(t).set(data).where(fence(c)).run().changes !== 1)
      throw new IdentityError(409);
  }
  return {
    get,
    find(eventId: string, agentId: AgentId) {
      z.uuid().parse(eventId);
      AgentId.parse(agentId);
      const row = db
        .select()
        .from(t)
        .where(and(eq(t.eventId, eventId), eq(t.agentId, agentId)))
        .get();
      return row === undefined ? undefined : Delivery.parse(row);
    },
    claim(agentIds: AgentId[]) {
      const ids = z.array(AgentId).min(1).max(32).parse(agentIds);
      return atomic(() => {
        // Expire only never-dispatched work. Frozen launches/uncertainty must remain reconcilable.
        const expired = db
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
              lte(t.expiresAt, sqliteNow),
              lte(t.leaseUntil, sqliteNow),
            ),
          )
          .returning()
          .all();
        for (const row of expired)
          history(Delivery.parse(row), 'undispatched-expiry');
        // Global capacity and per-agent oldest outstanding event serialize across independent processes.
        const capacity =
          db
            .select({ count: sql<number>`count(*)` })
            .from(t)
            .where(gt(t.leaseUntil, sqliteNow))
            .get()?.count ?? 0;
        if (capacity >= INBOX_CAPACITY) return undefined;
        const candidate = db
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              inArray(t.agentId, ids),
              inArray(t.state, ['ready', 'waiting', 'uncertain']),
              lte(t.nextAttempt, sqliteNow),
              lte(t.leaseUntil, sqliteNow),
              // An operator can resume an older blocked row while a newer row is leased.
              // Oldest-outstanding order alone does not exclude that live same-agent owner.
              sql`NOT EXISTS (SELECT 1 FROM agent_inbox active WHERE active.agent_id = ${t.agentId} AND active.lease_until > ${sqliteNow})`,
              sql`NOT EXISTS (SELECT 1 FROM agent_inbox older WHERE older.agent_id = ${t.agentId} AND older.position < ${t.position} AND older.state IN ('ready','waiting','uncertain'))`,
            ),
          )
          .orderBy(asc(t.nextAttempt), asc(t.position))
          .limit(1)
          .get();
        if (!candidate) return undefined;
        const row = db
          .update(t)
          .set({
            generation: sql`${t.generation}+1`,
            claimToken: randomUUID(),
            leaseUntil: sql`${sqliteNow}+${INBOX_LEASE_MS}`,
            attempts: sql`min(${t.attempts}+1,1000000)`,
          })
          .where(and(eq(t.id, candidate.id), lte(t.leaseUntil, sqliteNow)))
          .returning()
          .get();
        const claim = Claim.parse(row);
        history(claim, 'claimed');
        return claim;
      });
    },
    context(c: Claim, p: Principal) {
      return atomic(() => {
        const { profile, channel, task } = authorized(c, p);
        const raw = db
          .select()
          .from(s.communicationOutbox)
          .where(eq(s.communicationOutbox.id, c.eventId))
          .get();
        const fact = OutboxFact.parse(decode(raw?.fact ?? ''));
        if (fact.teamId !== c.teamId || fact.channelId !== c.channelId)
          throw new IdentityError(404);
        const message =
          c.messageId === null
            ? null
            : communication.message(p, c.teamId, c.channelId, c.messageId);
        const topic =
          c.topicId === null
            ? null
            : communication.topic(p, c.teamId, c.channelId, c.topicId);
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
      return atomic(() => {
        authorized(c, p);
        const value = FrozenLaunch.parse(launch);
        if (p.kind !== 'agent' || value.grantId !== p.grantId)
          throw new IdentityError(403);
        const row = get(c.id);
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
          const journaled = db
            .select({ id: s.executionOperations.id })
            .from(s.executionOperations)
            .where(
              and(
                eq(s.executionOperations.actor, 'inbox-agent:' + c.agentId),
                eq(s.executionOperations.operationKey, 'inbox:' + c.id),
              ),
            )
            .get();
          if (
            row.operationId !== null ||
            row.reference !== null ||
            journaled !== undefined
          )
            throw new IdentityError(403);
          update(c, {
            launch: JSON.stringify(value),
            reason: 'launch-refrozen',
          });
          history(get(c.id), 'launch-refrozen');
          return value;
        }
        update(c, { launch: JSON.stringify(value), reason: 'launch-frozen' });
        history(get(c.id), 'launch-frozen');
        return value;
      });
    },
    remember(c: Claim, reference: Reference | { operationId: string }) {
      atomic(() => {
        owned(c);
        const row = get(c.id);
        if ('operationId' in reference) {
          const id = z.string().min(1).max(256).parse(reference.operationId);
          if (row.operationId !== null && row.operationId !== id)
            throw new IdentityError(409);
          update(c, { operationId: id });
        } else {
          const ref = Reference.parse(reference);
          if (
            ref.runId === undefined ||
            (row.reference !== null && row.reference !== JSON.stringify(ref))
          )
            throw new IdentityError(409);
          update(c, { reference: JSON.stringify(ref) });
        }
        history(get(c.id), 'execution-correlated');
      });
    },
    defer(
      c: Claim,
      state: 'ready' | 'waiting' | 'uncertain' | 'blocked',
      reason: string,
    ) {
      atomic(() => {
        z.enum(['ready', 'waiting', 'uncertain', 'blocked']).parse(state);
        z.string()
          .regex(/^[a-z-]{1,80}$/)
          .parse(reason);
        update(c, {
          state,
          reason,
          claimToken: null,
          leaseUntil: 0,
          nextAttempt: sql`${sqliteNow}+${retryDelay(c.attempts)}`,
        });
        history(get(c.id), reason);
      });
    },
    ack(c: Claim, p: Principal, input: PublishedOutcome) {
      return atomic(() => {
        const { task } = authorized(c, p);
        const result = PublishedOutcome.parse(input);
        const row = get(c.id);
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
          db
            .select({ id: s.agentCorrelations.id })
            .from(s.agentCorrelations)
            .where(
              and(
                eq(s.agentCorrelations.teamId, c.teamId),
                eq(s.agentCorrelations.agentId, c.agentId),
                eq(
                  s.agentCorrelations.referenceKey,
                  fingerprint([
                    result.reference.backend,
                    result.reference.environmentId,
                    result.reference.threadId,
                    result.reference.runId,
                  ]),
                ),
              ),
            )
            .get() ??
          agents.correlate(p, c.teamId, c.agentId, {
            reference: result.reference,
            providerSessionId: null,
            invocationId: c.id,
          });
        agents.runtimeEvent(
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
            : (db
                .select({ id: s.taskExecutions.id })
                .from(s.taskExecutions)
                .where(
                  and(
                    eq(s.taskExecutions.taskId, task.id),
                    eq(
                      s.taskExecutions.referenceKey,
                      fingerprint([
                        result.reference.backend,
                        result.reference.environmentId,
                        result.reference.threadId,
                        result.reference.runId,
                      ]),
                    ),
                  ),
                )
                .get() ??
              tasks.recordInboxExecution(
                p,
                c.teamId,
                c.channelId,
                task.id,
                result.reference,
              ));
        // The message is the answer only. Where it came from (run, model,
        // state) is kept in inbox_results and shown beside it, not in it.
        const body =
          'kind' in result
            ? result.state === 'failed'
              ? 'The run in T3 failed before writing a reply.'
              : 'The run in T3 was stopped before writing a reply.'
            : result.text;
        const publicationReason =
          'kind' in result
            ? 'native-terminal-notice-published'
            : 'assistant-result-published';
        const message = communication.post(p, c.teamId, c.channelId, {
          operationKey: 'inbox-result:' + c.id,
          body,
          topicId: c.topicId,
          mentions: [],
          sourceMessageId: c.messageId,
          sourceEventId: c.eventId,
        });
        db.insert(s.inboxResults)
          .values({
            deliveryId: c.id,
            messageId: message.id,
            correlationId: correlation.id,
            taskLinkId: taskLink?.id ?? null,
            result: JSON.stringify(result),
          })
          .run();
        update(c, {
          state: 'acked',
          resultMessageId: message.id,
          claimToken: null,
          leaseUntil: 0,
          reason: publicationReason,
        });
        history(get(c.id), publicationReason);
        return message;
      });
    },
    /**
     * The first Kinmesh precondition a delivery no longer meets, so whoever
     * can fix it is told what to fix. Read-only; never grants authority.
     */
    blockedCause(c: Claim, token: () => string): BlockedReason {
      const agent = db
        .select({ lifecycle: s.agents.lifecycle })
        .from(s.agents)
        .where(and(eq(s.agents.id, c.agentId), eq(s.agents.teamId, c.teamId)))
        .get();
      if (agent?.lifecycle !== 'active') return 'agent-disabled';
      let p: Principal;
      try {
        p = agents.resolveToken(token());
      } catch {
        return 'credential-invalid';
      }
      const needed: Scope[] = ['executions:write', 'channels:write'];
      if (c.taskId !== null) needed.push('tasks:write');
      if (
        p.kind !== 'agent' ||
        p.agentId !== c.agentId ||
        !needed.every((scope) => p.scopes.includes(scope))
      )
        return 'credential-invalid';
      const joined = db
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
        .get();
      if (joined?.state !== 'joined') return 'not-in-channel';
      return c.taskId !== null
        ? 'not-assigned'
        : 'authority-or-contract-blocked';
    },
    // Operator-local recovery; owners use resumeAsOwner. Neither mints a new native operation key.
    resume(id: string) {
      atomic(() => {
        reopen(id, 'operator-resume');
      });
    },
    /**
     * Owner recovery from the workspace: the same resume, for a delivery in a
     * channel the owner can read. Retrying the same operation key replays.
     */
    resumeAsOwner(
      p: Principal,
      teamId: string,
      id: string,
      operationKey: string,
    ) {
      return atomic(() => {
        if (p.kind !== 'human') throw new IdentityError(403);
        if (
          agents.teamAccess(p, TeamId.parse(teamId), 'channels:read').role !==
          'owner'
        )
          throw new IdentityError(403);
        const row = db
          .select()
          .from(t)
          .where(eq(t.id, z.uuid().parse(id)))
          .get();
        if (row?.teamId !== teamId) throw new IdentityError(404);
        communication.channel(
          p,
          TeamId.parse(teamId),
          ChannelId.parse(row.channelId),
        );
        return receipt(
          'inbox-resume:' + teamId,
          operationKey,
          { id },
          z.strictObject({ id: z.uuid() }),
          () => {
            reopen(id, 'owner-resume');
            return { id };
          },
        );
      });
    },
    /** Liveness only, never authority: unknown or foreign agent IDs are ignored. */
    heartbeat(agentIds: string[]) {
      const ids = z.array(AgentId).parse(agentIds);
      if (ids.length === 0) return;
      atomic(() => {
        for (const agent of db
          .select({ id: s.agents.id, teamId: s.agents.teamId })
          .from(s.agents)
          .where(inArray(s.agents.id, ids))
          .all())
          db.insert(s.inboxBindings)
            .values({
              agentId: agent.id,
              teamId: agent.teamId,
              lastSeenAt: sqliteNow,
            })
            .onConflictDoUpdate({
              target: s.inboxBindings.agentId,
              set: { lastSeenAt: sqliteNow },
            })
            .run();
      });
    },
    /** A clean stop withdraws liveness at once instead of waiting for it to go stale. */
    release(agentIds: string[]) {
      const ids = z.array(AgentId).parse(agentIds);
      if (ids.length === 0) return;
      db.delete(s.inboxBindings)
        .where(inArray(s.inboxBindings.agentId, ids))
        .run();
    },
    /**
     * Read-only delivery view for a channel page: mention deliveries of the
     * given messages, deliveries answered by them, and task wakes. Callers
     * must already have authorized channel access. Worker internals (claim,
     * launch, operation, reference, counters) never leave this method.
     */
    deliveriesFor(
      teamId: string,
      channelId: string,
      messageIds: string[],
      taskIds: string[],
    ) {
      const ids = z.array(z.uuid()).max(100).parse(messageIds);
      const tasks = z.array(z.uuid()).max(100).parse(taskIds);
      if (ids.length === 0 && tasks.length === 0) return [];
      const rows = db
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
        .orderBy(asc(t.position))
        .all();
      return withTimes(rows);
    },
    /**
     * Blocked deliveries in the channels a member has joined, newest first.
     * The caller decides who may see them; the projection is allow-listed.
     */
    blockedIn(teamId: string, member: string) {
      const rows = db
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
        .where(and(eq(t.teamId, teamId), eq(t.state, 'blocked')))
        .orderBy(sql`${t.position} DESC`)
        .limit(50)
        .all();
      return withTimes(rows);
    },
    /** Deliveries still waiting for a worker to pick them up, per agent. */
    queuedPerAgent(teamId: string) {
      return db
        .select({ agentId: t.agentId, count: sql<number>`count(*)` })
        .from(t)
        .where(and(eq(t.teamId, teamId), eq(t.state, 'ready')))
        .groupBy(t.agentId)
        .all();
    },
    /**
     * Where each visible agent reply came from: the run's outcome, the model
     * it ran on and its T3 identifiers. Allow-listed; no prompts or tokens.
     */
    repliesFor(teamId: string, channelId: string, messageIds: string[]) {
      const ids = z.array(z.uuid()).max(100).parse(messageIds);
      if (ids.length === 0) return [];
      return db
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
        .all()
        .map((r) => {
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
    liveness(teamId: string) {
      return db
        .select({
          agentId: s.inboxBindings.agentId,
          lastSeenAt: s.inboxBindings.lastSeenAt,
        })
        .from(s.inboxBindings)
        .where(eq(s.inboxBindings.teamId, teamId))
        .all();
    },
    status() {
      return db
        .select({ state: t.state, count: sql<number>`count(*)` })
        .from(t)
        .groupBy(t.state)
        .all()
        .map((r) => ({ state: InboxState.parse(r.state), count: r.count }));
    },
  };
}
