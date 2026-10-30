import { z } from 'zod';
import { Ajv, type ValidateFunction } from 'ajv';
import { ExecutionFailure } from '../../domain/execution.js';

export const Status = z.enum([
  'idle',
  'preparing',
  'queued',
  'starting',
  'running',
  'waiting',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'rolled_back',
]);
export const Descriptor = z.object({
  environmentId: z.string().min(1),
  serverVersion: z.literal('0.1.5'),
});
export const Capabilities = z.object({
  runtimeMode: z.enum([
    'approval-required',
    'auto-accept-edits',
    'auto',
    'full-access',
  ]),
  providers: z.array(
    z.object({
      providerInstanceId: z.string(),
      driverKind: z.string(),
      models: z.array(z.object({ id: z.string() })),
      runtimeModes: z.array(z.string()).optional(),
      canRunChildTask: z.boolean(),
      constraints: z.array(z.string()),
    }),
  ),
});
export const Launched = z.object({
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().nullable(),
  status: Status.nullable(),
  modelSelection: z.object({ instanceId: z.string(), model: z.string() }),
});
export const Sent = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1),
  status: Status,
});
export const Read = z.object({
  thread: z.object({
    threadId: z.string(),
    projectId: z.string(),
    /** Optional native web link; may be custom or absent for other clients. */
    link: z.string().optional(),
    status: Status,
    latestRunId: z.string().nullable(),
    activeRunId: z.string().nullable(),
    pendingRequestCount: z.number().int().nonnegative(),
    providerInstanceId: z.string(),
    model: z.string(),
  }),
  recentRuns: z.array(
    z.object({
      runId: z.string(),
      status: Status,
      providerInstanceId: z.string(),
      model: z.string(),
    }),
  ),
  items: z.array(
    z.object({
      itemId: z.string(),
      runId: z.string().nullable(),
      type: z.string(),
      text: z.string().nullable(),
      textTruncated: z.boolean(),
    }),
  ),
  nextPosition: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean(),
});
export const Waited = z.object({
  threadId: z.string(),
  runId: z.string().nullable(),
  status: Status,
  timedOut: z.boolean(),
});
export const Interrupted = z.object({
  threadId: z.string(),
  runId: z.string().nullable(),
  status: z.enum([
    'interrupt_requested',
    'no_active_run',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'rolled_back',
  ]),
});
export const ToolList = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
export interface Wire {
  list(): Promise<unknown>;
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown>;
  close(): Promise<void>;
}
const Envelope = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .optional(),
});
const NativeFailure = z.object({ code: z.string() });
export class ValidatedTools {
  private readonly validators = new Map<
    string,
    { input: ValidateFunction; output: ValidateFunction }
  >();
  constructor(
    readonly wire: Wire,
    discovered: unknown,
  ) {
    const tools = ToolList.parse(discovered).tools;
    const ajv = new Ajv({ strict: false, allErrors: false });
    for (const name of [
      't3_environment_read',
      'orchestrator_capabilities',
      't3_thread_launch',
      't3_thread_read',
      't3_thread_send',
      't3_thread_wait',
      't3_thread_interrupt',
      't3_thread_organize',
    ]) {
      const tool = tools.find((t) => t.name === name);
      if (
        tool === undefined ||
        (tool.outputSchema === undefined && name !== 't3_thread_organize')
      )
        throw new ExecutionFailure('incompatible');
      // T3 0.1.5 omits the union outputSchema on organize. Archive returns its documented dispatch sequence.
      const output =
        tool.outputSchema ??
        z.toJSONSchema(z.object({ sequence: z.number().int().nonnegative() }), {
          target: 'draft-7',
        });
      if (
        ['t3_thread_launch', 't3_thread_send', 't3_thread_interrupt'].includes(
          name,
        )
      ) {
        const properties = z
          .object({ properties: z.record(z.string(), z.unknown()) })
          .parse(tool.inputSchema).properties;
        if (properties.clientRequestId === undefined)
          throw new ExecutionFailure('incompatible');
      }
      this.validators.set(name, {
        input: ajv.compile(tool.inputSchema),
        output: ajv.compile(output),
      });
    }
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30000,
  ): Promise<unknown> {
    const validator = this.validators.get(name);
    if (!validator?.input(args)) throw new ExecutionFailure('invalid-input');
    let raw: unknown;
    try {
      raw = await this.wire.call(name, args, signal, timeoutMs);
    } catch (error) {
      if (error instanceof ExecutionFailure) throw error;
      if (signal?.aborted) throw new ExecutionFailure('cancelled');
      const code = z.object({ code: z.number() }).safeParse(error);
      if (code.success && code.data.code === 401)
        throw new ExecutionFailure('authentication');
      if (code.success && code.data.code === 403)
        throw new ExecutionFailure('permission');
      throw new ExecutionFailure('unavailable');
    }
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) throw new ExecutionFailure('incompatible');
    const envelope = parsed.data;
    let value: unknown = envelope.structuredContent;
    if (value === undefined) {
      const text = envelope.content?.find((c) => c.type === 'text')?.text;
      try {
        value = JSON.parse(text ?? '');
      } catch {
        throw new ExecutionFailure('incompatible');
      }
    }
    if (envelope.isError) {
      const failure = NativeFailure.safeParse(value);
      if (failure.success && failure.data.code === 'capability_denied')
        throw new ExecutionFailure('permission');
      throw new ExecutionFailure('incompatible');
    }
    if (!validator.output(value)) throw new ExecutionFailure('incompatible');
    return value;
  }
}
