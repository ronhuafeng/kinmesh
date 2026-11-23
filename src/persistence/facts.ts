import type { Database } from './database.js';
import { enqueueFact } from './inbox-enqueue.js';
import { notifyFact } from './notify.js';
import { transactional } from './transactional.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import { type ChannelId, type TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { principalAuthor as author } from '../domain/tasks.js';
import { CommunicationFact, OutboxFact } from '../domain/communication.js';
import { decode, now } from './channel-values.js';

type ChannelId = z.infer<typeof ChannelId>;
/**
 * What happened in a channel, recorded as a fact on the outbox, handed to
 * the Inbox and to notifications; and an event the caller may see.
 */
export function factsOf(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
) {
  const { q } = transactional(d);

  async function fact(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    operationKey: string,
    kind: z.infer<typeof CommunicationFact>['kind'],
    extra: Partial<z.infer<typeof CommunicationFact>> = {},
  ) {
    const value = CommunicationFact.parse({
      version: 1,
      id: randomUUID(),
      teamId,
      channelId,
      createdAt: now(),
      author: author(p),
      kind,
      operationKey,
      topicId: null,
      messageId: null,
      mentions: [],
      participant: null,
      participantState: null,
      sourceMessageId: null,
      sourceEventId: null,
      ...extra,
    });
    await q()
      .insert(s.communicationOutbox)
      .values({ id: value.id, channelId, fact: JSON.stringify(value) });
    await enqueueFact(q(), value);
    await notifyFact(q(), value);
  }
  async function visibleEvent(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    eventId: string,
  ) {
    const row = (
      await q()
        .select()
        .from(s.communicationOutbox)
        .where(
          and(
            eq(s.communicationOutbox.id, eventId),
            eq(s.communicationOutbox.channelId, channelId),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) throw new DomainError('not-found');
    if (OutboxFact.parse(decode(row.fact)).kind === 'task.changed') {
      try {
        await agents.teamAccess(p, teamId, 'tasks:read');
      } catch (error) {
        if (error instanceof DomainError && error.kind === 'forbidden')
          throw new DomainError('not-found');
        throw error;
      }
    }
  }
  return { fact, visibleEvent };
}
export type Facts = ReturnType<typeof factsOf>;
