import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  Launch,
  Intent,
  Reference,
  ExecutionFailure,
  type Dispatch,
  type Observation,
  type ExecutionBackend,
  type WaitResult,
  type StopResult,
} from '../../domain/execution.js';
import type {
  Operation,
  OperationJournal,
} from '../../persistence/operations.js';
import {
  ValidatedTools,
  Descriptor,
  Capabilities,
  Launched,
  Sent,
  Read,
  Waited,
  Interrupted,
  type Wire,
} from './contracts.js';

const ranking = [
  'approval-required',
  'auto-accept-edits',
  'auto',
  'full-access',
];
export interface BackendOptions {
  endpoint: string;
  expectedEnvironmentId: string;
  linkedEnvironmentId?: string;
  authority: string;
  scopes: readonly string[];
}
export class T3Backend implements ExecutionBackend {
  readonly kind = 'external-t3';
  private constructor(
    private readonly tools: ValidatedTools,
    private readonly journal: OperationJournal,
    private readonly options: BackendOptions,
    private readonly caps: z.infer<typeof Capabilities>,
    readonly environmentId: string,
  ) {}
  static async connect(
    wire: Wire,
    journal: OperationJournal,
    options: BackendOptions,
  ) {
    try {
      if (!options.scopes.includes('orchestration:read'))
        throw new ExecutionFailure('permission');
      const tools = new ValidatedTools(wire, await wire.list());
      const primary = Descriptor.parse(
        await tools.call('t3_environment_read', {}),
      );
      if (primary.environmentId !== options.expectedEnvironmentId)
        throw new ExecutionFailure('incompatible');
      const target = options.linkedEnvironmentId;
      const args = target === undefined ? {} : { environmentId: target };
      const descriptor =
        target === undefined
          ? primary
          : Descriptor.parse(await tools.call('t3_environment_read', args));
      if (target !== undefined && descriptor.environmentId !== target)
        throw new ExecutionFailure('incompatible');
      const caps = Capabilities.parse(
        await tools.call('orchestrator_capabilities', args),
      );
      return new T3Backend(
        tools,
        journal,
        options,
        caps,
        descriptor.environmentId,
      );
    } catch (error) {
      if (error instanceof ExecutionFailure) throw error;
      throw new ExecutionFailure('incompatible');
    }
  }
  private target() {
    return this.options.linkedEnvironmentId === undefined
      ? {}
      : { environmentId: this.options.linkedEnvironmentId };
  }
  private scope() {
    return createHash('sha256')
      .update(JSON.stringify([this.options.endpoint, this.environmentId]))
      .digest('hex');
  }
  private ref(value: unknown) {
    const ref = Reference.parse(value);
    if (ref.environmentId !== this.environmentId)
      throw new ExecutionFailure('invalid-input');
    return ref;
  }
  private permitted() {
    if (!this.options.scopes.includes('orchestration:operate'))
      throw new ExecutionFailure('permission');
  }
  async launch(
    input: Launch,
    intent: Intent,
    signal?: AbortSignal,
  ): Promise<Dispatch> {
    const request = Launch.parse(input);
    this.permitted();
    const provider = this.caps.providers.find(
      (p) => p.providerInstanceId === request.model.providerId,
    );
    if (
      provider === undefined ||
      !provider.canRunChildTask ||
      provider.constraints.length > 0 ||
      !provider.models.some((m) => m.id === request.model.modelId)
    )
      throw new ExecutionFailure('incompatible');
    if (ranking.indexOf(request.mode) > ranking.indexOf(this.caps.runtimeMode))
      throw new ExecutionFailure('permission');
    if (
      provider.runtimeModes !== undefined &&
      !provider.runtimeModes.includes(request.mode)
    )
      throw new ExecutionFailure('incompatible');
    const args = {
      ...this.target(),
      ...(request.target.kind === 'project'
        ? {
            projectId: request.target.projectId,
            workspaceStrategy: { type: 'root' },
          }
        : { scratch: true }),
      title: request.title,
      modelSelection: {
        provider: provider.driverKind,
        instanceId: provider.providerInstanceId,
        model: request.model.modelId,
      },
      runtimeMode: request.mode,
      interactionMode: 'default',
      ...(request.message === undefined ? {} : { message: request.message }),
    };
    return this.dispatch('t3_thread_launch', args, intent, signal);
  }
  async send(
    reference: Reference,
    message: string,
    intent: Intent,
    signal?: AbortSignal,
  ): Promise<Dispatch> {
    this.permitted();
    const ref = this.ref(reference);
    const text = z.string().min(1).max(120000).parse(message);
    return this.dispatch(
      't3_thread_send',
      {
        ...this.target(),
        threadId: ref.threadId,
        message: text,
        mode: 'queue',
      },
      intent,
      signal,
    );
  }
  private async dispatch(
    tool: string,
    args: Record<string, unknown>,
    intent: Intent,
    signal?: AbortSignal,
  ): Promise<Dispatch> {
    if (signal?.aborted) throw new ExecutionFailure('cancelled');
    const row = this.journal.prepare(
      this.scope(),
      Intent.parse(intent),
      tool,
      args,
      this.options.authority,
    );
    if (row.phase === 'known')
      return {
        kind: 'known',
        reference: Reference.parse(JSON.parse(row.reference ?? '')),
      };
    if (row.phase === 'rejected')
      throw new ExecutionFailure(
        row.rejection === 'authentication' ? 'authentication' : 'permission',
      );
    if (!this.journal.claim(row.id))
      return { kind: 'uncertain', operationId: row.id, reason: 'in-flight' };
    return this.execute(row, signal);
  }
  private verifyObservation(row: Operation, observation: Observation) {
    if (observation.state === 'uncertain')
      throw new ExecutionFailure('incompatible');
    if (row.tool === 't3_thread_launch') {
      const selected = z
        .object({
          modelSelection: z.object({
            instanceId: z.string(),
            model: z.string(),
          }),
        })
        .parse(JSON.parse(row.payload)).modelSelection;
      if (
        observation.model.providerId !== selected.instanceId ||
        observation.model.modelId !== selected.model
      )
        throw new ExecutionFailure('incompatible');
    }
  }
  private async execute(
    row: Operation,
    signal?: AbortSignal,
  ): Promise<Dispatch> {
    let effectReturned = false;
    try {
      const args = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(row.payload));
      const raw = await this.tools.call(
        row.tool,
        { ...args, clientRequestId: row.requestId },
        signal,
      );
      let ref: Reference;
      if (row.tool === 't3_thread_launch') {
        const launched = Launched.parse(raw);
        if (typeof args.message === 'string' && launched.runId === null)
          throw new ExecutionFailure('incompatible');
        const model = z
          .object({ instanceId: z.string(), model: z.string() })
          .parse(args.modelSelection);
        if (
          launched.modelSelection.instanceId !== model.instanceId ||
          launched.modelSelection.model !== model.model
        )
          throw new ExecutionFailure('incompatible');
        ref = {
          backend: 't3',
          environmentId: this.environmentId,
          threadId: launched.threadId,
          ...(launched.runId === null ? {} : { runId: launched.runId }),
        };
      } else {
        const result =
          row.tool === 't3_thread_send'
            ? Sent.parse(raw)
            : Interrupted.parse(raw);
        if (result.threadId !== args.threadId)
          throw new ExecutionFailure('incompatible');
        ref = {
          backend: 't3',
          environmentId: this.environmentId,
          threadId: result.threadId,
          ...(result.runId === null ? {} : { runId: result.runId }),
        };
      }
      // A response is not enough: bind the journal only after an authoritative read succeeds.
      effectReturned = true;
      this.journal.remember(row.id, ref);
      const observation = await this.read(ref, undefined, signal);
      this.verifyObservation(row, observation);
      this.journal.known(row.id, ref);
      return { kind: 'known', reference: ref };
    } catch (error) {
      if (
        !effectReturned &&
        error instanceof ExecutionFailure &&
        (error.kind === 'permission' || error.kind === 'authentication')
      ) {
        this.journal.rejected(row.id, error.kind);
        throw error;
      }
      this.journal.uncertain(row.id);
      return {
        kind: 'uncertain',
        operationId: row.id,
        reason:
          error instanceof ExecutionFailure && error.kind === 'cancelled'
            ? 'cancelled'
            : error instanceof ExecutionFailure && error.kind === 'incompatible'
              ? 'incompatible'
              : 'unavailable',
      };
    }
  }
  async reconcile(
    intent: Intent,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<Dispatch> {
    this.permitted();
    Intent.parse(intent);
    const row = this.journal.get(operationId);
    if (
      row.scope !== this.scope() ||
      row.actor !== intent.actor ||
      row.operationKey !== intent.operationKey
    )
      throw new ExecutionFailure('permission');
    const args = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(row.payload));
    // Fingerprint also binds retries to the exact original OAuth authority; reauthorization cannot silently duplicate work.
    this.journal.prepare(
      this.scope(),
      intent,
      row.tool,
      args,
      this.options.authority,
    );
    if (row.phase === 'rejected')
      throw new ExecutionFailure(
        row.rejection === 'authentication' ? 'authentication' : 'permission',
      );
    if (row.phase === 'known') {
      const reference = Reference.parse(JSON.parse(row.reference ?? ''));
      await this.read(reference, undefined, signal);
      return { kind: 'known', reference };
    }
    if (row.reference !== null) {
      try {
        const reference = Reference.parse(JSON.parse(row.reference));
        const observation = await this.read(reference, undefined, signal);
        this.verifyObservation(row, observation);
        this.journal.known(row.id, reference);
        return { kind: 'known', reference };
      } catch {
        return {
          kind: 'uncertain',
          operationId: row.id,
          reason: 'unavailable',
        };
      }
    }
    // Explicit reconciliation replays only the persisted command/key on a version that advertises idempotency.
    return this.execute(row, signal);
  }
  async read(
    reference: Reference,
    afterPosition?: number,
    signal?: AbortSignal,
  ): Promise<Observation> {
    const ref = this.ref(reference);
    const cursor =
      afterPosition === undefined
        ? {}
        : {
            afterPosition: z.number().int().nonnegative().parse(afterPosition),
          };
    const result = Read.parse(
      await this.tools.call(
        't3_thread_read',
        {
          ...this.target(),
          threadId: ref.threadId,
          view: 'messages',
          limit: 100,
          runLimit: 50,
          maxCharsPerItem: 50000,
          ...cursor,
        },
        signal,
      ),
    );
    if (result.thread.threadId !== ref.threadId)
      throw new ExecutionFailure('incompatible');
    const run =
      ref.runId === undefined
        ? undefined
        : result.recentRuns.find((r) => r.runId === ref.runId);
    const status =
      ref.runId === undefined
        ? result.thread.status
        : (run?.status ?? 'unobserved');
    const terminal = [
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'rolled_back',
    ].includes(status);
    const state =
      status === 'completed'
        ? 'succeeded'
        : status === 'idle'
          ? 'idle'
          : status === 'waiting'
            ? 'waiting'
            : status === 'failed'
              ? 'failed'
              : ['cancelled', 'interrupted', 'rolled_back'].includes(status)
                ? 'stopped'
                : status === 'unobserved'
                  ? 'uncertain'
                  : 'active';
    return {
      reference: ref,
      state,
      backendStatus: status,
      model: {
        providerId: run?.providerInstanceId ?? result.thread.providerInstanceId,
        modelId: run?.model ?? result.thread.model,
      },
      terminal,
      acceptance: 'not-evaluated',
      pendingRequests: result.thread.pendingRequestCount,
      history: result.items.map((i) => ({
        id: i.itemId,
        runId: i.runId,
        type: i.type,
        text: i.text,
        truncated: i.textTruncated,
      })),
      nextPosition: result.nextPosition,
      hasMore: result.hasMore,
    };
  }
  async wait(
    reference: Reference,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    const ref = this.ref(reference);
    z.number().int().min(1).max(20000).parse(timeoutMs);
    const result = Waited.parse(
      await this.tools.call(
        't3_thread_wait',
        {
          ...this.target(),
          threadId: ref.threadId,
          ...(ref.runId === undefined ? {} : { runId: ref.runId }),
          timeoutMs,
        },
        signal,
        timeoutMs + 10000,
      ),
    );
    if (
      result.threadId !== ref.threadId ||
      (ref.runId !== undefined && result.runId !== ref.runId)
    )
      throw new ExecutionFailure('incompatible');
    if (result.timedOut)
      return { kind: 'timeout', reference: ref, backendStatus: result.status };
    return {
      kind: 'observed',
      observation: await this.read(ref, undefined, signal),
    };
  }
  async stop(
    reference: Reference,
    intent: Intent,
    signal?: AbortSignal,
  ): Promise<StopResult> {
    this.permitted();
    const ref = this.ref(reference);
    const result = await this.dispatch(
      't3_thread_interrupt',
      {
        ...this.target(),
        threadId: ref.threadId,
        ...(ref.runId === undefined ? {} : { runId: ref.runId }),
      },
      intent,
      signal,
    );
    if (result.kind === 'uncertain')
      return { kind: 'uncertain', operationId: result.operationId };
    const observation = await this.read(ref, undefined, signal);
    return {
      kind: observation.terminal ? 'terminal' : 'requested',
      observation,
    };
  }
}
