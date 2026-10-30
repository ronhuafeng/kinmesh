import { z } from 'zod';
import { AgentId, HumanId, TeamId, ChannelId, Channel } from './contracts.js';
import { Author } from './agents.js';
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
});
export const ParticipantInput = Mutation.extend({ member: Member });
export const TopicInput = Mutation.extend({
  title: z.string().trim().min(1).max(160),
});
export const PostInput = Mutation.extend({
  body: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .refine((v) => !v.includes('\u0000')),
  topicId: TopicId.nullable(),
  mentions: z
    .array(Member)
    .max(20)
    .refine((v) => new Set(v.map(memberKey)).size === v.length),
  sourceMessageId: MessageId.nullable(),
  sourceEventId: z.uuid().nullable(),
});
export type PostInput = z.infer<typeof PostInput>;
export const ChannelView = Channel.extend({
  position: z.number().int().positive(),
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
  body: z.string().min(1).max(8000),
  author: Author,
  createdAt: z.iso.datetime(),
  mentions: z.array(Member).max(20),
  sourceMessageId: MessageId.nullable(),
  sourceEventId: z.uuid().nullable(),
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
      'participant.changed',
      'topic.created',
      'message.posted',
    ]),
    topicId: TopicId.nullable(),
    messageId: MessageId.nullable(),
    mentions: z.array(Member).max(20),
    participant: Member.nullable(),
    participantState: z.enum(['joined', 'left', 'removed']).nullable(),
    sourceMessageId: MessageId.nullable(),
    sourceEventId: z.uuid().nullable(),
    operationKey: OperationKey,
  })
  .superRefine((v, ctx) => {
    const isMessage = v.kind === 'message.posted';
    const isParticipant = v.kind === 'participant.changed';
    if (
      isMessage !== (v.messageId !== null) ||
      isParticipant !== (v.participant !== null) ||
      isParticipant !== (v.participantState !== null) ||
      (v.kind === 'topic.created' && v.topicId === null) ||
      ((v.kind === 'channel.created' || isParticipant) && v.topicId !== null) ||
      (!isMessage &&
        (v.mentions.length !== 0 ||
          v.sourceMessageId !== null ||
          v.sourceEventId !== null))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid fact shape' });
  });
export const Event = z.strictObject({
  position: z.number().int().positive(),
  fact: CommunicationFact,
});
export const PageInput = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});
export type PageInput = z.input<typeof PageInput>;
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(100),
    nextCursor: z.string().nullable(),
  });
