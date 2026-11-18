import { TaskStatus, TaskAction } from './task-state.js';
import { TaskId } from './contracts.js';
import { z } from 'zod';
import {
  AgentId,
  HumanId,
  TeamId,
  ChannelId,
  Channel,
  Visibility,
} from './contracts.js';
import { Author } from './agents.js';
import {
  Attachment,
  AttachmentId,
  ATTACHMENTS_PER_MESSAGE,
} from './attachments.js';
export const TopicId = z.uuid().brand<'TopicId'>();
export const MessageId = z.uuid().brand<'MessageId'>();
export type TopicId = z.infer<typeof TopicId>;
export type MessageId = z.infer<typeof MessageId>;
export const Member = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), id: HumanId }),
  z.strictObject({ kind: z.literal('agent'), id: AgentId }),
]);
export type Member = z.infer<typeof Member>;
export const memberKey = (member: Member) => `${member.kind}:${member.id}`;
export const OperationKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
export const Mutation = z.strictObject({ operationKey: OperationKey });
export const ChannelInput = Mutation.extend({
  name: z.string().trim().min(1).max(80),
  /** Private unless asked: only those invited see it. */
  visibility: Visibility.default('private'),
});
export const ParticipantInput = Mutation.extend({ member: Member });
export const TopicInput = Mutation.extend({
  title: z.string().trim().min(1).max(160),
});
/**
 * A message: text, files a person uploaded to the channel (`attachments`),
 * or both. Text may be empty only when there are files.
 */
export const PostInput = Mutation.extend({
  body: z
    .string()
    .trim()
    .max(8000)
    .refine((v) => !v.includes('\u0000')),
  topicId: TopicId.nullable(),
  mentions: z
    .array(Member)
    .max(20)
    .refine((v) => new Set(v.map(memberKey)).size === v.length),
  sourceMessageId: MessageId.nullable(),
  sourceEventId: z.uuid().nullable(),
  attachments: z
    .array(AttachmentId)
    .max(ATTACHMENTS_PER_MESSAGE)
    .refine((v) => new Set(v).size === v.length)
    .default([]),
});
export type PostInput = z.infer<typeof PostInput>;
/**
 * A person has seen the channel up to this message, reading the whole
 * channel (`topicId` null) or one topic. It needs no operation key: reading
 * again changes nothing.
 */
export const ReadInput = z.strictObject({
  messageId: MessageId,
  topicId: TopicId.nullable(),
});
/** A joined person makes a channel public or private. */
export const VisibilityInput = z.strictObject({
  operationKey: OperationKey,
  visibility: Visibility,
});
export const ChannelView = Channel.extend({
  position: z.number().int().positive(),
});
/**
 * A channel's newest message, as a list of channels shows it: who wrote it,
 * the start of what they wrote, and when.
 */
export const ChannelLatest = z.strictObject({
  channelId: ChannelId,
  messageId: MessageId,
  author: Author,
  excerpt: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
  /** Whether someone else wrote in it after the person's read position. */
  unread: z.boolean(),
});
export const Topic = z.strictObject({
  id: TopicId,
  channelId: ChannelId,
  position: z.number().int().positive(),
  title: z.string().min(1).max(160),
  author: Author,
  createdAt: z.iso.datetime(),
});
export const Message = z.strictObject({
  id: MessageId,
  channelId: ChannelId,
  topicId: TopicId.nullable(),
  position: z.number().int().positive(),
  /** Empty only for a message of files alone. */
  body: z.string().max(8000),
  author: Author,
  createdAt: z.iso.datetime(),
  mentions: z.array(Member).max(20),
  sourceMessageId: MessageId.nullable(),
  sourceEventId: z.uuid().nullable(),
  attachments: z.array(Attachment).max(ATTACHMENTS_PER_MESSAGE),
  /** Files removed from it since: who removed each, and when. */
  removedAttachments: z
    .array(z.strictObject({ removedBy: HumanId, removedAt: z.iso.datetime() }))
    .max(ATTACHMENTS_PER_MESSAGE),
});
/** A file someone removed from a message, as the audit keeps it. */
export const AttachmentRemoval = z.strictObject({
  attachmentId: AttachmentId,
  messageId: MessageId,
  removedBy: HumanId,
  removedAt: z.iso.datetime(),
});
/** A file of the team, as the files page lists it. */
export const TeamFile = z.strictObject({
  attachment: Attachment,
  channelId: ChannelId,
  messageId: MessageId,
  uploader: HumanId,
  createdAt: z.iso.datetime(),
});
export const Participant = z.strictObject({
  channelId: ChannelId,
  teamId: TeamId,
  member: Member,
  state: z.enum(['joined', 'left', 'removed']),
});
export const CommunicationFact = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    teamId: TeamId,
    channelId: ChannelId,
    createdAt: z.iso.datetime(),
    author: Author,
    kind: z.enum([
      'channel.created',
      'channel.changed',
      'participant.changed',
      'topic.created',
      'message.posted',
      'attachment.removed',
    ]),
    topicId: TopicId.nullable(),
    messageId: MessageId.nullable(),
    mentions: z.array(Member).max(20),
    participant: Member.nullable(),
    participantState: z.enum(['joined', 'left', 'removed']).nullable(),
    sourceMessageId: MessageId.nullable(),
    sourceEventId: z.uuid().nullable(),
    operationKey: OperationKey,
    /** What a channel.changed made the channel. */
    visibility: Visibility.optional(),
  })
  .superRefine((v, ctx) => {
    const isMessage = v.kind === 'message.posted';
    const isParticipant = v.kind === 'participant.changed';
    if (
      (isMessage || v.kind === 'attachment.removed') !==
        (v.messageId !== null) ||
      isParticipant !== (v.participant !== null) ||
      isParticipant !== (v.participantState !== null) ||
      (v.kind === 'topic.created' && v.topicId === null) ||
      (v.kind === 'channel.changed') !== (v.visibility !== undefined) ||
      ((v.kind === 'channel.created' ||
        v.kind === 'channel.changed' ||
        isParticipant) &&
        v.topicId !== null) ||
      (!isMessage &&
        (v.mentions.length !== 0 ||
          v.sourceMessageId !== null ||
          v.sourceEventId !== null))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid fact shape' });
  });
export const TaskFact = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  teamId: TeamId,
  channelId: ChannelId,
  createdAt: z.iso.datetime(),
  author: Author,
  kind: z.literal('task.changed'),
  topicId: TopicId.nullable(),
  messageId: z.null(),
  mentions: z.array(Member).max(2),
  participant: z.null(),
  participantState: z.null(),
  sourceMessageId: z.uuid().nullable(),
  sourceEventId: z.uuid().nullable(),
  operationKey: OperationKey,
  taskId: TaskId,
  taskVersion: z.number().int().positive(),
  taskStatus: TaskStatus,
  taskAction: TaskAction,
  owner: Member.nullable(),
  reviewer: Member.nullable(),
  executionLinkId: z.uuid().nullable(),
});
export const OutboxFact = z.union([CommunicationFact, TaskFact]);
export const Event = z.strictObject({
  position: z.number().int().positive(),
  fact: OutboxFact,
});
export const PageInput = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});
export type PageInput = z.input<typeof PageInput>;
/** Most messages or tasks a newest page widened back by a cursor holds. */
export const REACH = 200;
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(100),
    nextCursor: z.string().nullable(),
  });
