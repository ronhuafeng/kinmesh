import { createHash } from 'node:crypto';
import { z } from 'zod';
export const Reference = z.strictObject({
  backend: z.literal('t3'),
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1).optional(),
});
export type Reference = z.infer<typeof Reference>;
export const Intent = z.strictObject({
  actor: z.string().min(1).max(128),
  operationKey: z.string().min(1).max(128),
});
export type Intent = z.infer<typeof Intent>;
export const Launch = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('project'),
      projectId: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal('scratch') }),
  ]),
  title: z.string().trim().min(1).max(200),
  message: z.string().min(1).max(120000).optional(),
  model: z.strictObject({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
  }),
  mode: z
    .enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])
    .default('approval-required'),
});
export type Launch = z.infer<typeof Launch>;
export const Dispatch = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('known'),
    reference: Reference,
    /**
     * How T3 took a sent message, when this call sent it: a replayed or
     * reconciled operation doesn't say.
     */
    delivery: z.enum(['started', 'queued', 'steered', 'restarted']).optional(),
  }),
  z.strictObject({
    kind: z.literal('uncertain'),
    operationId: z.string(),
    reason: z.enum([
      'unavailable',
      'cancelled',
      'incompatible',
      'unreadable',
      'in-flight',
    ]),
  }),
]);
export type Dispatch = z.infer<typeof Dispatch>;
/** What a run under way is on: what waits on a person, or its last step. */
export interface Step {
  waiting: boolean;
  text: string;
}
export interface Observation {
  reference: Reference;
  state:
    | 'idle'
    | 'active'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'stopped'
    | 'uncertain';
  backendStatus: string;
  model: { providerId: string; modelId: string };
  terminal: boolean;
  acceptance: 'not-evaluated';
  /** Requests waiting on a person: the run's, or the thread's when none is named. */
  pendingRequests: number;
  /**
   * While the run is under way, what it is on, in T3's words: what waits on
   * a person's approval, or the step it is taking. Null when not known.
   */
  step?: Step | null;
  history: {
    id: string;
    position: number;
    runId: string | null;
    type: string;
    text: string | null;
    truncated: boolean;
  }[];
  nextPosition: number | null;
  hasMore: boolean;
}
export type WaitResult =
  | { kind: 'timeout'; reference: Reference; backendStatus: string }
  | { kind: 'observed'; observation: Observation };
export type StopResult =
  | { kind: 'uncertain'; operationId: string }
  | { kind: 'requested' | 'terminal'; observation: Observation };
export type FailureKind =
  | 'authentication'
  | 'permission'
  | 'unavailable'
  | 'incompatible'
  /** T3 answered with data outside the contract Kinmesh reads it by. */
  | 'unreadable'
  | 'invalid-input'
  | 'cancelled'
  | 'conflict'
  /** The thread no longer exists in T3; nothing was done in it. */
  | 'gone';
export class ExecutionFailure extends Error {
  override readonly name = 'ExecutionFailure';
  constructor(readonly kind: FailureKind) {
    super(`Execution request failed: ${kind}`);
  }
}
export interface ExecutionBackend {
  readonly kind: 'external-t3';
  launch(
    input: Launch,
    intent: Intent,
    signal?: AbortSignal,
  ): Promise<Dispatch>;
  /**
   * A new message in an existing thread. `queue` waits for the thread's
   * current turn; `auto` starts an idle thread or steers the running turn.
   */
  send(
    reference: Reference,
    message: string,
    intent: Intent,
    signal?: AbortSignal,
    mode?: 'queue' | 'auto',
  ): Promise<Dispatch>;
  /**
   * The runtime mode a launch on this provider runs in: the grant's ceiling,
   * or the broadest below it that the provider runs.
   */
  mode(providerId: string): Launch['mode'];
  /**
   * The project whose folder is `workspaceRoot`, if T3 has one; null if not.
   */
  project(workspaceRoot: string, signal?: AbortSignal): Promise<string | null>;
  read(
    reference: Reference,
    afterPosition?: number,
    signal?: AbortSignal,
  ): Promise<Observation>;
  wait(
    reference: Reference,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitResult>;
  stop(
    reference: Reference,
    intent: Intent,
    signal?: AbortSignal,
  ): Promise<StopResult>;
  reconcile(
    intent: Intent,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<Dispatch>;
}
/** One native operation as the journal keeps it. */
export const Operation = z.object({
  id: z.string(),
  scope: z.string(),
  actor: z.string(),
  operationKey: z.string(),
  requestId: z.string(),
  fingerprint: z.string(),
  tool: z.string(),
  payload: z.string(),
  phase: z.enum(['prepared', 'dispatching', 'uncertain', 'known', 'rejected']),
  reference: z.string().nullable(),
  rejection: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  claimToken: z.string().nullable(),
  leaseUntil: z.number().int().nonnegative(),
});
export type Operation = z.infer<typeof Operation>;
/** An operation under one owner's claim, which fences every later write. */
export const ClaimedOperation = Operation.extend({
  claimToken: z.uuid(),
  leaseUntil: z.number().int().positive(),
});
export type ClaimedOperation = z.infer<typeof ClaimedOperation>;
// SDK mutations default to 30s; an entire attempt is capped at 60s. No lease renewal.
export const EXECUTION_LEASE_MS = 120_000;
export const EXECUTION_ATTEMPT_MS = 60_000;
/** The journal scope of one T3 environment behind one endpoint. */
export const executionScope = (endpoint: string, environmentId: string) =>
  createHash('sha256')
    .update(JSON.stringify([endpoint, environmentId]))
    .digest('hex');
/**
 * The durable record of the native operations an adapter dispatches. Intent
 * is kept before dispatch; after a claim, each write lands only while that
 * claim still owns the operation, and says whether it did.
 */
export interface OperationJournal {
  prepare(
    scope: string,
    intent: Intent,
    tool: string,
    payload: Record<string, unknown>,
    authority: string,
  ): Promise<Operation>;
  get(id: string): Promise<Operation>;
  claim(id: string, recover?: boolean): Promise<ClaimedOperation | undefined>;
  owned(row: ClaimedOperation): Promise<boolean>;
  uncertain(row: ClaimedOperation): Promise<boolean>;
  remember(row: ClaimedOperation, reference: Reference): Promise<boolean>;
  known(row: ClaimedOperation, reference: Reference): Promise<boolean>;
  rejected(
    row: ClaimedOperation,
    kind: 'authentication' | 'permission' | 'gone',
  ): Promise<boolean>;
}
