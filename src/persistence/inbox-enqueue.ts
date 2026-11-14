import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { CHAIN_BUDGET, INBOX_TTL_MS, wakeTargets } from '../domain/inbox.js';
import { OutboxFact } from '../domain/communication.js';
import * as s from './schema.js';
import { dbNow, type Query } from './database.js';

/** Caller MUST own the fact transaction. No checkpoint or post-commit queue gap. */
export async function enqueueFact(db: Query, input: unknown) {
  const fact = OutboxFact.parse(input);
  const targets = wakeTargets(fact);
  if (fact.kind !== 'task.changed' && targets.length === 0) return;
  const parent =
    fact.author.kind === 'agent' && fact.sourceEventId !== null
      ? (
          await db
            .select()
            .from(s.inboxCauses)
            .where(eq(s.inboxCauses.eventId, fact.sourceEventId))
            .limit(1)
        )[0]
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
  await db.insert(s.inboxCauses).values({ eventId: fact.id, rootId, depth });
  if (depth > CHAIN_BUDGET) return;
  for (const target of targets) {
    const [joined] = await db
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
      .limit(1);
    if (!joined) continue;
    const [inserted] = await db
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
        nextAttempt: dbNow,
        expiresAt: sql`${dbNow} + ${INBOX_TTL_MS}`,
      })
      .onConflictDoNothing()
      .returning({ id: s.agentInbox.id });
    if (inserted)
      await db.insert(s.inboxHistory).values({
        deliveryId: inserted.id,
        generation: 0,
        state: 'ready',
        reason: 'enqueued',
        createdAt: dbNow,
      });
  }
}
