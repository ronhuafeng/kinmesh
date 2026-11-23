import type { Database } from './database.js';
import { transactional } from './transactional.js';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import * as s from './schema.js';
import { type ChannelId, type TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import type { MessageId } from '../domain/communication.js';
import { PINS_MOST, PinInput } from '../domain/communication.js';
import type { ChannelAccess } from './channel-access.js';
import type { MessageViews } from './message-views.js';

type ChannelId = z.infer<typeof ChannelId>;
/** Messages pinned in a channel. */
export function pinRepository(
  d: Database,
  gate: ChannelAccess,
  views: MessageViews,
) {
  const { q, atomic } = transactional(d);
  const { access } = gate;
  const { message, pinsOf } = views;

  return {
    /**
     * A person in the channel pins a message there, or unpins it. Doing what
     * is done changes nothing; a channel keeps at most `PINS_MOST`.
     */
    pin(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageId: MessageId,
      input: z.infer<typeof PinInput>,
    ) {
      const { on } = PinInput.parse(input);
      return atomic(async () => {
        if (p.kind !== 'human') throw new DomainError('forbidden');
        const { participant } = await access(p, teamId, channelId);
        if (participant?.state !== 'joined') throw new DomainError('not-found');
        await message(channelId, messageId);
        if (on) {
          const [count] = await q()
            .select({ n: sql<number>`count(*)::int` })
            .from(s.channelPins)
            .where(eq(s.channelPins.channelId, channelId));
          if ((count?.n ?? 0) >= PINS_MOST) throw new DomainError('conflict');
          await q()
            .insert(s.channelPins)
            .values({
              channelId,
              messageId,
              pinnedBy: p.humanId,
              pinnedAt: Date.now(),
            })
            .onConflictDoNothing();
        } else
          await q()
            .delete(s.channelPins)
            .where(
              and(
                eq(s.channelPins.channelId, channelId),
                eq(s.channelPins.messageId, messageId),
              ),
            );
        return pinsOf(channelId);
      });
    },
    /** A channel's pinned messages, for whoever can read it. */
    pins(p: Principal, teamId: TeamId, channelId: ChannelId) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return pinsOf(channelId);
      });
    },
  };
}
