import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CHAIN_BUDGET, INBOX_TTL_MS, wakeTargets } from '../domain/inbox.js';
import { OutboxFact } from '../domain/communication.js';
import * as s from './schema.js';

export const sqliteNow = sql`cast(unixepoch('subsec') * 1000 as integer)`;
/** Caller MUST own the fact transaction. No checkpoint or post-commit queue gap. */
export function enqueueFact(
  db: BetterSQLite3Database<typeof s>,
  input: unknown,
) {
  const fact = OutboxFact.parse(input);
  const targets = wakeTargets(fact);
  if (fact.kind !== 'task.changed' && targets.length === 0) return;
  const parent =
    fact.author.kind === 'agent' && fact.sourceEventId !== null
      ? db
          .select()
          .from(s.inboxCauses)
          .where(eq(s.inboxCauses.eventId, fact.sourceEventId))
          .get()
      : undefined;
  // Human action is the only way to reset a task's trusted causal chain.
  const rootId = fact.author.kind === 'human' ? fact.id : parent?.rootId;
  if (rootId === undefined) return;
  const depth =
    fact.author.kind === 'human'
      ? 0
      : Math.min(
          CHAIN_BUDGET + 1,
          (parent?.depth ?? CHAIN_BUDGET) + (targets.length > 0 ? 1 : 0),
        );
  db.insert(s.inboxCauses).values({ eventId: fact.id, rootId, depth }).run();
  if (depth > CHAIN_BUDGET) return;
  for (const target of targets) {
    const joined = db
      .select({ id: s.agents.id })
      .from(s.agents)
      .innerJoin(
        s.channelParticipants,
        and(
          eq(s.channelParticipants.agentId, s.agents.id),
          eq(s.channelParticipants.teamId, s.agents.teamId),
        ),
      )
      .where(
        and(
          eq(s.agents.id, target.id),
          eq(s.agents.teamId, fact.teamId),
          eq(s.agents.lifecycle, 'active'),
          eq(s.channelParticipants.channelId, fact.channelId),
          eq(s.channelParticipants.state, 'joined'),
        ),
      )
      .get();
    if (!joined) continue;
    const inserted = db
      .insert(s.agentInbox)
      .values({
        id: randomUUID(),
        eventId: fact.id,
        teamId: fact.teamId,
        channelId: fact.channelId,
        agentId: target.id,
        rootId,
        depth,
        taskId: fact.kind === 'task.changed' ? fact.taskId : null,
        messageId: fact.messageId ?? fact.sourceMessageId,
        topicId: fact.topicId,
        state: 'ready',
        nextAttempt: sqliteNow,
        expiresAt: sql`${sqliteNow} + ${INBOX_TTL_MS}`,
      })
      .onConflictDoNothing()
      .returning({ id: s.agentInbox.id })
      .all()[0];
    if (inserted)
      db.insert(s.inboxHistory)
        .values({
          deliveryId: inserted.id,
          generation: 0,
          state: 'ready',
          reason: 'enqueued',
          createdAt: sqliteNow,
        })
        .run();
  }
}
