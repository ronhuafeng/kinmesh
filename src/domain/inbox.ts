import { z } from 'zod';
import { AgentId, ChannelId, TeamId, TaskId } from './contracts.js';
import { Author } from './agents.js';
import { MessageId, TopicId, type OutboxFact } from './communication.js';
import { Launch, Reference } from './execution.js';

export const INBOX_LEASE_MS = 180_000;
export const INBOX_ATTEMPT_MS = 90_000;
export const INBOX_CAPACITY = 2;
export const CHAIN_BUDGET = 4;
export const INBOX_TTL_MS = 7 * 86400_000;
export const InboxState = z.enum([
  'ready',
  'waiting',
  'uncertain',
  'acked',
  'blocked',
  'expired',
]);
export const Delivery = z.object({
  position: z.number().int().positive(),
  id: z.uuid(),
  eventId: z.uuid(),
  teamId: TeamId,
  channelId: ChannelId,
  agentId: AgentId,
  rootId: z.uuid(),
  depth: z.number().int().min(0).max(CHAIN_BUDGET),
  taskId: TaskId.nullable(),
  messageId: MessageId.nullable(),
  topicId: TopicId.nullable(),
  state: InboxState,
  generation: z.number().int().nonnegative(),
  claimToken: z.uuid().nullable(),
  leaseUntil: z.number().int().nonnegative(),
  nextAttempt: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  launch: z.string().nullable(),
  operationId: z.string().nullable(),
  reference: z.string().nullable(),
  resultMessageId: MessageId.nullable(),
  reason: z.string().max(80),
});
export type Delivery = z.infer<typeof Delivery>;
export const Claim = Delivery.extend({
  claimToken: z.uuid(),
  leaseUntil: z.number().int().positive(),
});
export type Claim = z.infer<typeof Claim>;
export const SourceContext = z.strictObject({
  deliveryId: z.uuid(),
  eventId: z.uuid(),
  rootId: z.uuid(),
  depth: z.number().int().min(0).max(CHAIN_BUDGET),
  agentId: AgentId,
  teamId: TeamId,
  channelId: ChannelId,
  channelName: z.string().max(80),
  author: Author,
  topic: z.strictObject({ id: TopicId, title: z.string().max(160) }).nullable(),
  message: z
    .strictObject({
      id: MessageId,
      body: z.string().max(4000),
      truncated: z.boolean(),
    })
    .nullable(),
  task: z
    .strictObject({
      id: TaskId,
      title: z.string().max(160),
      description: z.string().max(2000),
      status: z.string().max(40),
      version: z.number().int().positive(),
      criteria: z.array(z.string().max(200)).max(5),
      truncated: z.boolean(),
    })
    .nullable(),
  memoryLocation: z.string().max(1024).nullable(),
});
export type SourceContext = z.infer<typeof SourceContext>;
export const ExecutionBinding = z.strictObject({
  endpoint: z.url().max(4096),
  environmentId: z.string().min(1).max(256),
  authority: z.string().min(1).max(128),
});
export type ExecutionBinding = z.infer<typeof ExecutionBinding>;
export const FrozenLaunch = z.strictObject({
  execution: ExecutionBinding,
  grantId: z.uuid(),
  input: Launch,
});
export const Result = z.strictObject({
  reference: Reference.extend({
    environmentId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
  }),
  itemId: z.string().min(1).max(256),
  text: z
    .string()
    .trim()
    .min(1)
    .max(6000)
    .refine((v) => !v.includes('\u0000')),
  truncated: z.boolean(),
  state: z.enum(['succeeded', 'failed', 'stopped']),
});
export type Result = z.infer<typeof Result>;
/** Verified terminal native status without a retrievable exact-run assistant item.
 * This is a status notice, never a synthetic assistant message. */
export const NativeTerminalNotice = z.strictObject({
  kind: z.literal('native-terminal-no-assistant'),
  reference: Result.shape.reference,
  state: z.enum(['failed', 'stopped']),
});
export type NativeTerminalNotice = z.infer<typeof NativeTerminalNotice>;
export const PublishedOutcome = z.union([Result, NativeTerminalNotice]);
export type PublishedOutcome = z.infer<typeof PublishedOutcome>;
/** Only explicit human mentions and changes of task responsibility wake agents.
 * Agent messages cannot mint wake chains; task audit predecessors establish agent handoff causality. */
export function wakeTargets(fact: z.infer<typeof OutboxFact>) {
  if (fact.kind === 'message.posted')
    return fact.author.kind === 'human'
      ? fact.mentions.filter((m) => m.kind === 'agent')
      : [];
  if (fact.kind !== 'task.changed') return [];
  const target =
    fact.taskStatus === 'review-requested'
      ? fact.reviewer
      : ['in-progress', 'rework-requested'].includes(fact.taskStatus)
        ? fact.owner
        : null;
  const relevant =
    ['create', 'handoff', 'request-review', 'rework'].includes(
      fact.taskAction,
    ) ||
    (fact.taskAction === 'review' && fact.taskStatus === 'rework-requested');
  if (
    !relevant ||
    target?.kind !== 'agent' ||
    (fact.author.kind === 'agent' && target.id === fact.author.agentId)
  )
    return [];
  return [target];
}
export const retryDelay = (attempts: number) =>
  Math.min(300_000, 1000 * 2 ** Math.min(9, Math.max(0, attempts - 1)));
