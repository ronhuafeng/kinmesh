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
  z.strictObject({ kind: z.literal('known'), reference: Reference }),
  z.strictObject({
    kind: z.literal('uncertain'),
    operationId: z.string(),
    reason: z.enum(['unavailable', 'cancelled', 'incompatible', 'in-flight']),
  }),
]);
export type Dispatch = z.infer<typeof Dispatch>;
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
  pendingRequests: number;
  history: {
    id: string;
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
  | 'invalid-input'
  | 'cancelled'
  | 'conflict';
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
  send(
    reference: Reference,
    message: string,
    intent: Intent,
    signal?: AbortSignal,
  ): Promise<Dispatch>;
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
