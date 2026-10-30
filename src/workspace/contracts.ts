import { z } from 'zod';
import { EventType, PROTOCOL_VERSION } from '@ag-ui/core';
import { StateSnapshotEventSchema } from '@ag-ui/core/schemas';
import { Agent, Correlation, RuntimeEvent } from '../domain/agents.js';
import { Human, Team, AgentId } from '../domain/contracts.js';
import {
  ChannelView,
  Message,
  Topic,
  pageOf,
} from '../domain/communication.js';
import { Task } from '../domain/tasks.js';

export const WorkspaceSnapshot = z.strictObject({
  observedAt: z.iso.datetime(),
  human: Human,
  team: Team,
  channels: pageOf(ChannelView),
  channel: ChannelView.nullable(),
  agents: z.array(Agent).max(100),
  agentsTruncated: z.boolean(),
  joinedAgentIds: z.array(AgentId).max(100),
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
