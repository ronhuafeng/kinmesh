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
  type Operation,
  type ClaimedOperation,
  type OperationJournal,
  EXECUTION_ATTEMPT_MS,
  executionScope,
} from '../../domain/execution.js';
import {
  ValidatedTools,
  EXECUTION_TOOLS,
  OPTIONAL_TOOLS,
  Descriptor,
  Capabilities,
  Launched,
  Sent,
  Read,
  Waited,
  Interrupted,
  Projects,
  runnable,
  launchMode,
  RUNTIME_MODES,
  selectRun,
  reply,
  type Wire,
} from './contracts.js';

/** What a journaled refusal is when it is replayed. */
const rejection = (kind: string | null) =>
  kind === 'authentication' || kind === 'gone' ? kind : 'permission';
/**
 * Why a dispatch whose effect in T3 is unknown stays unknown. A reply that
 * doesn't fit the contract will not fit on the next attempt either.
 */
const unknownBecause = (error: unknown) =>
  error instanceof ExecutionFailure &&
  (error.kind === 'cancelled' ||
    error.kind === 'incompatible' ||
    error.kind === 'unreadable')
    ? error.kind
    : 'unavailable';
export interface BackendOptions {
  endpoint: string;
  expectedEnvironmentId: string;
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
      const tools = new ValidatedTools(
        wire,
        await wire.list(),
        EXECUTION_TOOLS,
        OPTIONAL_TOOLS,
      );
      const descriptor = Descriptor.parse(
        await tools.call('t3_environment_read', {}),
      );
      if (descriptor.environmentId !== options.expectedEnvironmentId)
        throw new ExecutionFailure('incompatible');
      const caps = Capabilities.parse(
        await tools.call('orchestrator_capabilities', {}),
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
  private scope() {
    return executionScope(this.options.endpoint, this.environmentId);
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
  /**
   * The mode a launch on this provider runs in (`launchMode`). A provider
   * that runs none gets the narrowest, which the launch then refuses.
   */
  mode(providerId: string): Launch['mode'] {
    const provider = this.caps.providers.find(
      (p) => p.providerInstanceId === providerId,
    );
    return (
      (provider && launchMode(provider, this.caps.runtimeMode)) ??
      'approval-required'
    );
  }
  /** Validate native launch prerequisites without preparing or dispatching an operation. */
  validateLaunch(input: Launch): void {
    this.launchArguments(input);
  }
  private launchArguments(input: Launch) {
    const request = Launch.parse(input);
    this.permitted();
    const provider = this.caps.providers.find(
      (p) => p.providerInstanceId === request.model.providerId,
    );
    if (!provider?.models.some((m) => m.id === request.model.modelId))
      throw new ExecutionFailure('incompatible');
    if (
      RUNTIME_MODES.indexOf(request.mode) >
      RUNTIME_MODES.indexOf(this.caps.runtimeMode)
    )
      throw new ExecutionFailure('permission');
    if (!runnable(provider, request.mode))
      throw new ExecutionFailure('incompatible');
    return {
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
  }
  async launch(
    input: Launch,
    intent: Intent,
    signal?: AbortSignal,
  ): Promise<Dispatch> {
    const args = this.launchArguments(input);
    return this.dispatch('t3_thread_launch', args, intent, signal);
  }
  async send(
    reference: Reference,
    message: string,
    intent: Intent,
    signal?: AbortSignal,
    mode: 'queue' | 'auto' = 'queue',
  ): Promise<Dispatch> {
    this.permitted();
    const ref = this.ref(reference);
    const text = z.string().min(1).max(120000).parse(message);
    return this.dispatch(
      't3_thread_send',
      {
        threadId: ref.threadId,
        message: text,
        mode: z.enum(['queue', 'auto']).parse(mode),
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
    const row = await this.journal.prepare(
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
      throw new ExecutionFailure(rejection(row.rejection));
    // Normal dispatch never replays an uncertain intent; explicit reconciliation owns recovery.
    if (row.phase !== 'prepared')
      return { kind: 'uncertain', operationId: row.id, reason: 'in-flight' };
    const claim = await this.journal.claim(row.id);
    if (!claim)
      return { kind: 'uncertain', operationId: row.id, reason: 'in-flight' };
    return this.execute(claim, signal);
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
    row: ClaimedOperation,
    signal?: AbortSignal,
  ): Promise<Dispatch> {
    const deadline = AbortSignal.timeout(EXECUTION_ATTEMPT_MS);
    signal =
      signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    let effectReturned = false;
    try {
      const args = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(row.payload));
      signal.throwIfAborted();
      if (!(await this.journal.owned(row))) return this.fenced(row.id);
      const raw = await this.tools.call(
        row.tool,
        { ...args, clientRequestId: row.requestId },
        signal,
      );
      let ref: Reference;
      let delivery: z.infer<typeof Sent>['delivery'] | undefined;
      if (row.tool === 't3_thread_launch') {
        const launched = reply(Launched, raw);
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
            ? reply(Sent, raw)
            : reply(Interrupted, raw);
        if ('delivery' in result) delivery = result.delivery;
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
      if (!(await this.journal.remember(row, ref))) return this.fenced(row.id);
      const observation = await this.read(ref, undefined, signal);
      this.verifyObservation(row, observation);
      if (!(await this.journal.known(row, ref))) return this.fenced(row.id);
      return {
        kind: 'known',
        reference: ref,
        ...(delivery === undefined ? {} : { delivery }),
      };
    } catch (error) {
      if (
        !effectReturned &&
        error instanceof ExecutionFailure &&
        (error.kind === 'permission' ||
          error.kind === 'authentication' ||
          error.kind === 'gone')
      ) {
        if (!(await this.journal.rejected(row, error.kind)))
          return this.fenced(row.id);
        throw error;
      }
      if (!(await this.journal.uncertain(row))) return this.fenced(row.id);
      return {
        kind: 'uncertain',
        operationId: row.id,
        reason: unknownBecause(error),
      };
    }
  }
  private fenced(id: string): Dispatch {
    return { kind: 'uncertain', operationId: id, reason: 'in-flight' };
  }
  async reconcile(
    intent: Intent,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<Dispatch> {
    this.permitted();
    if (signal?.aborted) throw new ExecutionFailure('cancelled');
    Intent.parse(intent);
    let row = await this.journal.get(operationId);
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
    row = await this.journal.prepare(
      this.scope(),
      intent,
      row.tool,
      args,
      this.options.authority,
    );
    if (row.phase === 'rejected')
      throw new ExecutionFailure(rejection(row.rejection));
    if (row.phase === 'known') {
      const reference = Reference.parse(JSON.parse(row.reference ?? ''));
      await this.read(reference, undefined, signal);
      return { kind: 'known', reference };
    }
    const claim = await this.journal.claim(row.id, true);
    if (!claim) return this.fenced(row.id);
    // Claim returns the current reference atomically; an active dispatcher cannot be raced.
    if (claim.reference !== null) {
      const deadline = AbortSignal.timeout(EXECUTION_ATTEMPT_MS);
      signal =
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      try {
        const reference = Reference.parse(JSON.parse(claim.reference));
        const observation = await this.read(reference, undefined, signal);
        this.verifyObservation(claim, observation);
        if (!(await this.journal.known(claim, reference)))
          return this.fenced(row.id);
        return { kind: 'known', reference };
      } catch (error) {
        if (!(await this.journal.uncertain(claim))) return this.fenced(row.id);
        return {
          kind: 'uncertain',
          operationId: row.id,
          reason: unknownBecause(error),
        };
      }
    }
    // Explicit reconciliation replays only the persisted command/key on a version that advertises idempotency.
    return this.execute(claim, signal);
  }
  async project(workspaceRoot: string, signal?: AbortSignal) {
    const root = z.string().min(1).max(4096).parse(workspaceRoot);
    let cursor: number | undefined;
    // T3 pages its projects; a page bound keeps a long list from looping.
    for (let page = 0; page < 20; page++) {
      const result = Projects.parse(
        await this.tools.call(
          't3_project_list',
          { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
          signal,
        ),
      );
      const found = result.projects.find(
        (p) => p.workspaceRoot === root && !p.deletedAt,
      );
      if (found) return found.id;
      if (result.nextCursor == null || result.nextCursor === cursor)
        return null;
      cursor = result.nextCursor;
    }
    return null;
  }
  /**
   * The requests in T3 waiting on a person for this run. T3 counts pending
   * requests for the whole thread, and keeps the one a run interrupted while
   * waiting for an approval left behind, so the thread's count would have a
   * later run waiting for an approval it never asked for. The run's own are
   * the items it wrote that still wait; a run waiting on a person wrote them
   * last, so they are among the thread's latest items.
   */
  private async waitingOn(
    threadId: string,
    runId: string,
    itemCount: number,
    signal?: AbortSignal,
  ) {
    let after = itemCount > 100 ? itemCount - 101 : undefined;
    let waiting = 0;
    // A page bound keeps a thread that grows while it is read from looping.
    for (let page = 0; page < 4; page++) {
      const result = reply(
        Read,
        await this.tools.call(
          't3_thread_read',
          {
            threadId,
            view: 'activity',
            limit: 100,
            runLimit: 1,
            maxCharsPerItem: 1,
            ...(after === undefined ? {} : { afterPosition: after }),
          },
          signal,
        ),
      );
      if (result.thread.threadId !== threadId)
        throw new ExecutionFailure('incompatible');
      waiting += result.items.filter(
        (i) => i.runId === runId && i.status === 'waiting',
      ).length;
      if (
        !result.hasMore ||
        result.nextPosition === null ||
        result.nextPosition === after
      )
        break;
      after = result.nextPosition;
    }
    return waiting;
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
    const result = reply(
      Read,
      await this.tools.call(
        't3_thread_read',
        {
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
    const { status, terminal, providerId, modelId } = selectRun(
      result,
      ref.runId,
    );
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
      model: { providerId, modelId },
      terminal,
      acceptance: 'not-evaluated',
      pendingRequests:
        ref.runId === undefined
          ? result.thread.pendingRequestCount
          : terminal || result.thread.pendingRequestCount === 0
            ? 0
            : await this.waitingOn(
                ref.threadId,
                ref.runId,
                result.thread.itemCount,
                signal,
              ),
      history: result.items.map((i) => ({
        id: i.itemId,
        position: i.position,
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
    const result = reply(
      Waited,
      await this.tools.call(
        't3_thread_wait',
        {
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
