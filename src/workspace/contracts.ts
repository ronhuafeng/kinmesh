import { z } from 'zod';
import { EventType, PROTOCOL_VERSION } from '@ag-ui/core';
import { StateSnapshotEventSchema } from '@ag-ui/core/schemas';
import { Agent, Correlation, RuntimeEvent } from '../domain/agents.js';
import { Reference } from '../domain/execution.js';
import { nativeThreadUrl } from './links.js';
import { Status } from '../adapters/t3/contracts.js';
import { Human, Team, AgentId } from '../domain/contracts.js';
import {
  ChannelView,
  Message,
  Topic,
  pageOf,
} from '../domain/communication.js';
import { Task } from '../domain/tasks.js';
import { InboxState } from '../domain/inbox.js';

export const WorkspaceSnapshot = z.strictObject({
  observedAt: z.iso.datetime(),
  nativeT3Origin: z
    .url()
    .refine((origin) => new URL(origin).origin === origin)
    .nullable(),
  human: Human,
  team: Team,
  channels: pageOf(ChannelView),
  channel: ChannelView.nullable(),
  agents: z.array(Agent).max(100),
  agentsTruncated: z.boolean(),
  joinedAgentIds: z.array(AgentId).max(100),
  /** Inbox deliveries for the visible messages and tasks (allow-listed fields only). */
  deliveries: z
    .array(
      z.strictObject({
        id: z.uuid(),
        agentId: AgentId,
        messageId: z.uuid().nullable(),
        taskId: z.uuid().nullable(),
        state: InboxState,
        reason: z.string().regex(/^[a-z][a-z-]{0,63}$/),
        queuedAt: z.iso.datetime().nullable(),
        updatedAt: z.iso.datetime().nullable(),
        resultMessageId: z.uuid().nullable(),
      }),
    )
    .max(1000),
  /** Inbox worker liveness per agent; absent means no worker has ever claimed it. */
  wake: z
    .array(
      z.strictObject({
        agentId: AgentId,
        connected: z.boolean(),
        lastSeenAt: z.iso.datetime(),
      }),
    )
    .max(100),
  messages: pageOf(Message),
  topics: pageOf(Topic),
  tasks: pageOf(Task),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>;
export const ExecutionSnapshot = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  source: z.literal('kinmesh-persisted-reports'),
  observedAt: z.iso.datetime(),
  agent: Agent,
  executions: z
    .array(
      z.strictObject({
        correlation: Correlation,
        events: z.array(RuntimeEvent).max(100),
        eventsTruncated: z.boolean(),
      }),
    )
    .max(20),
  executionsTruncated: z.boolean(),
});
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshot>;
/** AG-UI 1.0 state snapshots only: no lifecycle, token or approval events. */
export function executionEvent(snapshot: ExecutionSnapshot) {
  return StateSnapshotEventSchema.parse({
    type: EventType.STATE_SNAPSHOT,
    timestamp: Date.now(),
    snapshot: ExecutionSnapshot.parse(snapshot),
  });
}
export function decodeExecutionEvent(value: unknown): ExecutionSnapshot {
  const event = StateSnapshotEventSchema.parse(value);
  return ExecutionSnapshot.parse(event.snapshot);
}

/** One fresh authoritative native read, never a fabricated AG-UI lifecycle stream. */
export const NativeObservation = z
  .strictObject({
    source: z.literal('t3-native-verified'),
    observedAt: z.iso.datetime(),
    reference: Reference,
    status: z.union([Status, z.literal('unobserved')]),
    terminal: z.boolean(),
    threadPendingRequests: z.number().int().nonnegative(),
    providerId: z.string().min(1).nullable(),
    modelId: z.string().min(1).nullable(),
    verifiedUrl: z.url().nullable(),
  })
  .refine(
    (value) =>
      value.verifiedUrl === null ||
      nativeThreadUrl(value.verifiedUrl, value.reference) !== null,
    { message: 'Invalid native thread URL' },
  )
  .refine(
    (value) =>
      value.terminal ===
      [
        'completed',
        'failed',
        'cancelled',
        'interrupted',
        'rolled_back',
      ].includes(value.status),
    { message: 'Inconsistent native terminal state' },
  );
export type NativeObservation = z.infer<typeof NativeObservation>;

/** Bind every response to the immutable association requested by the browser. */
export function decodeNativeObservation(
  value: unknown,
  expected: z.infer<typeof Reference>,
  trustedOrigin: string | null,
): NativeObservation {
  const result = NativeObservation.parse(value);
  if (
    result.reference.environmentId !== expected.environmentId ||
    result.reference.threadId !== expected.threadId ||
    result.reference.runId !== expected.runId
  )
    throw new Error('Mismatched native reference');
  if (
    result.verifiedUrl !== null &&
    (trustedOrigin === null ||
      new URL(result.verifiedUrl).origin !== trustedOrigin)
  )
    throw new Error('Mismatched native origin');
  return result;
}
