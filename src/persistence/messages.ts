import type { Database } from './database.js';
import { transactional, latestPage } from './transactional.js';
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  isNull,
  lt,
  lte,
  max,
  sql,
} from 'drizzle-orm';
import type { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import { type ChannelId, type TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import {
  principalAuthor as author,
  principalMember as member,
} from '../domain/tasks.js';
import type { TopicId } from '../domain/communication.js';
import {
  EditInput,
  Event,
  Message,
  MessageId,
  Mutation,
  type PageInput,
  PostInput,
  memberKey,
} from '../domain/communication.js';
import { decode, now, escapeLike, page, highest } from './channel-values.js';
import type { ChannelAccess } from './channel-access.js';
import type { Facts } from './facts.js';
import type { MessageViews } from './message-views.js';

type ChannelId = z.infer<typeof ChannelId>;
/**
 * Messages: posted with their mentions and files, edited or withdrawn by
 * their author, read along a channel or topic, searched, and the events
 * of a channel.
 */
export function messageRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
  gate: ChannelAccess,
  facts: Facts,
  views: MessageViews,
) {
  const { q, atomic } = transactional(d);
  const { team, access, validTarget, mutation } = gate;
  const { fact, visibleEvent } = facts;
  const { topic, withMentions, message } = views;

  /**
   * A message of a channel the person is in that they wrote and have not
   * withdrawn: the only kind they may change.
   */
  async function ownMessage(
    p: Principal & { kind: 'human' },
    teamId: TeamId,
    channelId: ChannelId,
    messageId: MessageId,
  ) {
    const { participant } = await access(p, teamId, channelId, true);
    if (participant?.state !== 'joined') throw new DomainError('not-found');
    const found = await message(channelId, messageId);
    if (found.author.kind !== 'human' || found.author.humanId !== p.humanId)
      throw new DomainError('forbidden');
    if (found.withdrawnAt !== null) throw new DomainError('conflict');
    return found;
  }
  /** Changes what a message says, keeping what it said before. */
  async function changeMessage(
    p: Principal & { kind: 'human' },
    found: z.infer<typeof Message>,
    kind: 'edit' | 'withdraw',
    body: string,
  ) {
    const at = now();
    await q().insert(s.messageEdits).values({
      messageId: found.id,
      channelId: found.channelId,
      kind,
      previousBody: found.body,
      editedBy: p.humanId,
      editedAt: at,
    });
    const change =
      kind === 'edit' ? { body, editedAt: at } : { body, withdrawnAt: at };
    await q().update(s.messages).set(change).where(eq(s.messages.id, found.id));
    return Message.parse({ ...found, ...change });
  }
  return {
    async validateCause(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageId: string | null,
      eventId: string | null,
    ) {
      await access(p, teamId, channelId);
      if (messageId !== null)
        await message(channelId, MessageId.parse(messageId));
      if (eventId !== null) await visibleEvent(p, teamId, channelId, eventId);
    },
    /**
     * Its author says a message again, on the record: what it said before is
     * kept, and nothing that came of it (deliveries, tasks, notifications)
     * changes. Saying the same again changes nothing.
     */
    edit(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageId: MessageId,
      input: z.infer<typeof EditInput>,
    ) {
      return atomic(async () => {
        if (p.kind !== 'human') throw new DomainError('forbidden');
        const data = EditInput.parse(input);
        return mutation(
          p,
          teamId,
          messageId,
          'message.edit',
          data,
          Message,
          async () => {
            const found = await ownMessage(p, teamId, channelId, messageId);
            if (found.body === data.body) return found;
            if (data.body === '' && found.attachments.length === 0)
              throw new DomainError('invalid');
            return changeMessage(p, found, 'edit', data.body);
          },
        );
      });
    },
    /**
     * Its author withdraws a message: its text is gone (kept only in the
     * record of what it said), and so is it from search. A message with
     * files is withdrawn once they are removed. Final.
     */
    withdraw(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      messageId: MessageId,
      input: z.infer<typeof Mutation>,
    ) {
      return atomic(async () => {
        if (p.kind !== 'human') throw new DomainError('forbidden');
        const data = Mutation.parse(input);
        return mutation(
          p,
          teamId,
          messageId,
          'message.withdraw',
          data,
          Message,
          async () => {
            const found = await ownMessage(p, teamId, channelId, messageId);
            if (found.attachments.length > 0) throw new DomainError('conflict');
            return changeMessage(p, found, 'withdraw', '');
          },
        );
      });
    },
    post(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: z.input<typeof PostInput>,
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId, true);
        const data = PostInput.parse(input);
        return mutation(
          p,
          teamId,
          channelId,
          'message.post',
          data,
          Message,
          async () => {
            // Text, files, or both; only a person attaches files.
            if (data.body === '' && data.attachments.length === 0)
              throw new DomainError('invalid');
            if (data.attachments.length > 0 && p.kind !== 'human')
              throw new DomainError('invalid');
            if (data.topicId !== null) await topic(channelId, data.topicId);
            for (const target of data.mentions)
              await validTarget(teamId, channelId, target, true);
            if (data.sourceMessageId !== null)
              await message(channelId, data.sourceMessageId);
            if (data.sourceEventId !== null)
              await visibleEvent(p, teamId, channelId, data.sourceEventId);
            const id = MessageId.parse(randomUUID());
            await q()
              .insert(s.messages)
              .values({
                id,
                channelId,
                topicId: data.topicId,
                body: data.body,
                author: JSON.stringify(author(p)),
                createdAt: now(),
                sourceMessageId: data.sourceMessageId,
                sourceEventId: data.sourceEventId,
              });
            for (const target of data.mentions)
              await q()
                .insert(s.messageMentions)
                .values({
                  messageId: id,
                  channelId,
                  memberKey: memberKey(target),
                  target: JSON.stringify(target),
                });
            // Their own uploads to this channel that no message took yet.
            for (const attachmentId of data.attachments) {
              const bound =
                p.kind === 'human'
                  ? await q()
                      .update(s.attachments)
                      .set({ messageId: id })
                      .where(
                        and(
                          eq(s.attachments.id, attachmentId),
                          eq(s.attachments.channelId, channelId),
                          eq(s.attachments.uploader, p.humanId),
                          isNull(s.attachments.messageId),
                        ),
                      )
                      .returning({ id: s.attachments.id })
                  : [];
              if (bound.length === 0) throw new DomainError('invalid');
            }
            await fact(
              p,
              teamId,
              channelId,
              data.operationKey,
              'message.posted',
              {
                messageId: id,
                topicId: data.topicId,
                mentions: data.mentions,
                sourceMessageId: data.sourceMessageId,
                sourceEventId: data.sourceEventId,
              },
            );
            return message(channelId, id);
          },
        );
      });
    },
    message(p: Principal, teamId: TeamId, channelId: ChannelId, id: MessageId) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return message(channelId, id);
      });
    },
    /**
     * A channel's (or topic's) messages from the newest: the latest page,
     * then older pages by cursor (`latestPage`). `reach` widens the latest
     * page back through an older one, for a view that scrolled back.
     */
    history(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
      topicId: TopicId | null = null,
      reach?: string,
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        if (topicId !== null) await topic(channelId, topicId);
        const condition = and(
          eq(s.messages.channelId, channelId),
          topicId === null ? undefined : eq(s.messages.topicId, topicId),
        );
        return latestPage(
          input,
          ['messages', teamId, channelId, topicId, memberKey(member(p))],
          Message,
          async (before, floor, limit) =>
            withMentions(
              await q()
                .select()
                .from(s.messages)
                .where(
                  and(
                    condition,
                    before === null
                      ? undefined
                      : lt(s.messages.position, before),
                    gte(s.messages.position, floor),
                  ),
                )
                .orderBy(desc(s.messages.position))
                .limit(limit),
            ),
          reach,
        );
      });
    },
    /**
     * Messages in the channels the person is in whose text holds what was
     * typed, any case, newest first: each with its channel and the start of
     * its text.
     */
    searchMessages(p: Principal, teamId: TeamId, text: string, limit = 10) {
      return atomic(async () => {
        await team(p, teamId);
        const rows = await q()
          .select({
            id: s.messages.id,
            channelId: s.messages.channelId,
            topicId: s.messages.topicId,
            body: s.messages.body,
            author: s.messages.author,
            createdAt: s.messages.createdAt,
          })
          .from(s.messages)
          .innerJoin(s.channels, eq(s.channels.id, s.messages.channelId))
          .innerJoin(
            s.channelParticipants,
            and(
              eq(s.channelParticipants.channelId, s.messages.channelId),
              eq(s.channelParticipants.memberKey, memberKey(member(p))),
              eq(s.channelParticipants.state, 'joined'),
            ),
          )
          .where(
            and(
              eq(s.channels.teamId, teamId),
              ilike(s.messages.body, '%' + escapeLike(text) + '%'),
            ),
          )
          .orderBy(desc(s.messages.position))
          .limit(limit);
        return rows.map((r) => ({
          messageId: MessageId.parse(r.id),
          channelId: r.channelId,
          topicId: r.topicId,
          excerpt: r.body.replace(/\s+/g, ' ').slice(0, 160),
          author: decode(r.author),
          createdAt: r.createdAt,
        }));
      });
    },
    events(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        let taskFacts = true;
        if (p.kind === 'agent') {
          try {
            await agents.teamAccess(p, teamId, 'tasks:read');
          } catch (error) {
            if (error instanceof DomainError && error.kind === 'forbidden')
              taskFacts = false;
            else throw error;
          }
        }
        const condition = and(
          eq(s.communicationOutbox.channelId, channelId),
          taskFacts
            ? undefined
            : sql`(${s.communicationOutbox.fact}::jsonb ->> 'kind') != 'task.changed'`,
        );
        return page(
          input,
          ['events', teamId, channelId, memberKey(member(p)), taskFacts],
          Event,
          async () =>
            highest(
              (
                await q()
                  .select({ value: max(s.communicationOutbox.position) })
                  .from(s.communicationOutbox)
                  .where(condition)
                  .limit(1)
              )[0]?.value,
            ),
          async (after, maximum, limit) =>
            (
              await q()
                .select()
                .from(s.communicationOutbox)
                .where(
                  and(
                    condition,
                    gt(s.communicationOutbox.position, after),
                    lte(s.communicationOutbox.position, maximum),
                  ),
                )
                .orderBy(asc(s.communicationOutbox.position))
                .limit(limit)
            ).map((r) =>
              Event.parse({ position: r.position, fact: decode(r.fact) }),
            ),
        );
      });
    },
  };
}
