import type { Database } from './database.js';
import { transactional } from './transactional.js';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import * as s from './schema.js';
import { HumanId, type ChannelId } from '../domain/contracts.js';
import { DomainError } from '../domain/errors.js';
import { Attachment } from '../domain/attachments.js';
import type { MessageId, TopicId } from '../domain/communication.js';
import {
  Member,
  Message,
  MessageReactions,
  PINS_MOST,
  Pinned,
  Topic,
} from '../domain/communication.js';
import { decode } from './channel-values.js';

type ChannelId = z.infer<typeof ChannelId>;
/**
 * Messages as they are read: with their mentions, files and removals, a
 * channel's reactions and pins, and topics.
 */
export function messageViews(d: Database) {
  const { q } = transactional(d);

  const topicOf = (row: typeof s.topics.$inferSelect) =>
    Topic.parse({ ...row, author: decode(row.author) });
  async function topic(channelId: ChannelId, id: TopicId) {
    const row = (
      await q()
        .select()
        .from(s.topics)
        .where(and(eq(s.topics.id, id), eq(s.topics.channelId, channelId)))
        .limit(1)
    )[0];
    if (row === undefined) throw new DomainError('not-found');
    return topicOf(row);
  }
  /** Messages as read, each with its mentions: one more query for them all. */
  /** Each message's reactions, grouped by reaction, oldest reactor first. */
  async function reactionsOf(channelId: ChannelId, messageIds: string[]) {
    if (messageIds.length === 0) return [];
    const rows = await q()
      .select({
        messageId: s.messageReactions.messageId,
        emoji: s.messageReactions.emoji,
        humanId: s.messageReactions.humanId,
      })
      .from(s.messageReactions)
      .where(
        and(
          eq(s.messageReactions.channelId, channelId),
          inArray(s.messageReactions.messageId, messageIds),
        ),
      )
      .orderBy(asc(s.messageReactions.createdAt));
    const grouped = new Map<string, z.infer<typeof MessageReactions>>();
    for (const r of rows) {
      const key = r.messageId + ' ' + r.emoji;
      const kept = grouped.get(key);
      if (kept) kept.humanIds.push(HumanId.parse(r.humanId));
      else
        grouped.set(
          key,
          MessageReactions.parse({
            messageId: r.messageId,
            emoji: r.emoji,
            humanIds: [r.humanId],
          }),
        );
    }
    return [...grouped.values()];
  }
  const attachmentOf = (row: typeof s.attachments.$inferSelect) =>
    Attachment.parse({
      id: row.id,
      name: row.name,
      type: row.type,
      size: row.size,
      width: row.width,
      height: row.height,
    });
  /** Messages' files, each message's in the order they were uploaded. */
  async function attachmentsOf(messageIds: string[]) {
    const found = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return found;
    for (const row of await q()
      .select()
      .from(s.attachments)
      .where(inArray(s.attachments.messageId, messageIds))
      .orderBy(asc(s.attachments.createdAt), asc(s.attachments.id))) {
      if (row.messageId === null) continue;
      found.set(row.messageId, [
        ...(found.get(row.messageId) ?? []),
        attachmentOf(row),
      ]);
    }
    return found;
  }
  async function withMentions(rows: (typeof s.messages.$inferSelect)[]) {
    const mentions = new Map<string, Member[]>();
    if (rows.length > 0)
      for (const r of await q()
        .select({
          messageId: s.messageMentions.messageId,
          target: s.messageMentions.target,
        })
        .from(s.messageMentions)
        .where(
          inArray(
            s.messageMentions.messageId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(
          asc(s.messageMentions.messageId),
          asc(s.messageMentions.memberKey),
        ))
        mentions.set(r.messageId, [
          ...(mentions.get(r.messageId) ?? []),
          Member.parse(decode(r.target)),
        ]);
    const ids = rows.map((row) => row.id);
    const files = await attachmentsOf(ids);
    const removed = new Map<
      string,
      { removedBy: string; removedAt: string }[]
    >();
    if (ids.length > 0)
      for (const r of await q()
        .select()
        .from(s.attachmentRemovals)
        .where(inArray(s.attachmentRemovals.messageId, ids))
        .orderBy(asc(s.attachmentRemovals.removedAt)))
        removed.set(r.messageId, [
          ...(removed.get(r.messageId) ?? []),
          {
            removedBy: r.removedBy,
            removedAt: new Date(r.removedAt).toISOString(),
          },
        ]);
    return rows.map((row) =>
      Message.parse({
        ...row,
        author: decode(row.author),
        mentions: mentions.get(row.id) ?? [],
        attachments: files.get(row.id) ?? [],
        removedAttachments: removed.get(row.id) ?? [],
      }),
    );
  }
  async function message(channelId: ChannelId, id: MessageId) {
    const row = (
      await q()
        .select()
        .from(s.messages)
        .where(and(eq(s.messages.id, id), eq(s.messages.channelId, channelId)))
        .limit(1)
    )[0];
    if (row === undefined) throw new DomainError('not-found');
    const [found] = await withMentions([row]);
    if (found === undefined) throw new DomainError('not-found');
    return found;
  }
  /** A channel's pinned messages, the latest pinned first. */
  async function pinsOf(channelId: ChannelId) {
    const rows = await q()
      .select({
        pin: s.channelPins,
        message: s.messages,
      })
      .from(s.channelPins)
      .innerJoin(
        s.messages,
        and(
          eq(s.messages.id, s.channelPins.messageId),
          eq(s.messages.channelId, s.channelPins.channelId),
        ),
      )
      .where(eq(s.channelPins.channelId, channelId))
      .orderBy(desc(s.channelPins.pinnedAt))
      .limit(PINS_MOST);
    const messages = await withMentions(rows.map((r) => r.message));
    return rows.map((r, i) =>
      Pinned.parse({
        message: messages[i],
        pinnedBy: r.pin.pinnedBy,
        pinnedAt: new Date(r.pin.pinnedAt).toISOString(),
      }),
    );
  }
  return {
    topicOf,
    topic,
    reactionsOf,
    attachmentOf,
    attachmentsOf,
    withMentions,
    message,
    pinsOf,
  };
}
export type MessageViews = ReturnType<typeof messageViews>;
