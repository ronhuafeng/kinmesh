import type { Database } from './database.js';
import { transactional } from './transactional.js';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import * as s from './schema.js';
import { type ChannelId, type TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import type { MessageId } from '../domain/communication.js';
import { ReactInput } from '../domain/communication.js';
import type { ChannelAccess } from './channel-access.js';
import type { MessageViews } from './message-views.js';

type ChannelId = z.infer<typeof ChannelId>;
/** People's reactions to messages, from a small fixed set. */
export function reactionRepository(
  d: Database,
  gate: ChannelAccess,
  views: MessageViews,
) {
  const { q, atomic } = transactional(d);
  const { access } = gate;
  const { reactionsOf, message } = views;

  return {
    /**
     * A person adds or takes back a reaction to a message of a channel they
     * joined. Doing what is already done changes nothing; nobody is woken or
     * notified. Answers the message's reactions as they are now.
     */
    react(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageId: MessageId,
      input: z.infer<typeof ReactInput>,
    ) {
      const { emoji, on } = ReactInput.parse(input);
      return atomic(async () => {
        if (p.kind !== 'human') throw new DomainError('forbidden');
        const { participant } = await access(p, teamId, channelId);
        if (participant?.state !== 'joined') throw new DomainError('not-found');
        await message(channelId, messageId);
        if (on)
          await q()
            .insert(s.messageReactions)
            .values({
              messageId,
              channelId,
              humanId: p.humanId,
              emoji,
              createdAt: Date.now(),
            })
            .onConflictDoNothing();
        else
          await q()
            .delete(s.messageReactions)
            .where(
              and(
                eq(s.messageReactions.messageId, messageId),
                eq(s.messageReactions.humanId, p.humanId),
                eq(s.messageReactions.emoji, emoji),
              ),
            );
        return reactionsOf(channelId, [messageId]);
      });
    },
    /** The reactions to these messages of a channel the person can read. */
    reactions(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageIds: string[],
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return reactionsOf(channelId, messageIds);
      });
    },
  };
}
