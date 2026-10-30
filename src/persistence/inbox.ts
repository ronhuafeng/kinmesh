import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { communicationRepository } from './communication.js';
import type { taskRepository } from './tasks.js';
import { transactional } from './transactional.js';
import { sqliteNow } from './inbox-enqueue.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import { AgentId } from '../domain/contracts.js';
import { OutboxFact } from '../domain/communication.js';
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
} from '../domain/inbox.js';
import { Reference } from '../domain/execution.js';

const decode = (value: string): unknown => JSON.parse(value);
export function inboxRepository(
  db: BetterSQLite3Database<typeof s>,
  agents: ReturnType<typeof agentRepository>,
  communication: ReturnType<typeof communicationRepository>,
  tasks: ReturnType<typeof taskRepository>,
) {
  const { atomic } = transactional(db);
  const t = s.agentInbox;
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
      if (assigned?.kind !== 'agent' || assigned.id !== c.agentId)
        throw new IdentityError(403);
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
        const old = get(c.id).launch;
        if (old !== null) {
          const frozen = FrozenLaunch.parse(decode(old));
          if (
            frozen.grantId !== p.grantId ||
            JSON.stringify(frozen.execution) !== JSON.stringify(value.execution)
          )
            throw new IdentityError(403);
          return frozen;
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
        const correlation = agents.correlate(p, c.teamId, c.agentId, {
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
        const taskLink =
          task === null
            ? null
            : tasks.command(p, c.teamId, c.channelId, task.id, {
                type: 'link-execution',
                expectedVersion: task.version,
                operationKey: 'inbox-link:' + c.id,
                reference: result.reference,
                note:
                  'kind' in result
                    ? 'Inbox native terminal status; human acceptance remains separate.'
                    : 'Inbox execution result; human acceptance remains separate.',
              }).executionLink;
        const body =
          'kind' in result
            ? `[T3 ${result.state}; native status notice only; no assistant message observed in bounded read; environment ${result.reference.environmentId}; thread ${result.reference.threadId}; run ${result.reference.runId}; inbox ${c.id}; source event ${c.eventId}]`
            : `${result.text}\n\n[T3 ${result.state}${result.truncated ? '; excerpt' : ''}; environment ${result.reference.environmentId}; thread ${result.reference.threadId}; run ${result.reference.runId}; item ${result.itemId}; inbox ${c.id}; source event ${c.eventId}]`;
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
    // Operator-local recovery only; no HTTP/MCP authority or new native operation key.
    resume(id: string) {
      atomic(() => {
        const row = get(id);
        if (row.state !== 'blocked') throw new IdentityError(409);
        const changed = db
          .update(t)
          .set({
            state: row.reference === null ? 'uncertain' : 'waiting',
            reason: 'operator-resume',
            nextAttempt: sqliteNow,
          })
          .where(
            and(
              eq(t.id, id),
              eq(t.state, 'blocked'),
              lte(t.leaseUntil, sqliteNow),
            ),
          )
          .run();
        if (changed.changes !== 1) throw new IdentityError(409);
        history(get(id), 'operator-resume');
      });
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
