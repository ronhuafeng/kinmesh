import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../persistence/store.js';
import { refused } from '../persistence/database.js';
import { loadAgentToken } from '../team-mcp/client.js';
import { z } from 'zod';
import {
  ExecutionFailure,
  Reference,
  type Dispatch,
  type ExecutionBackend,
  type Observation,
} from '../domain/execution.js';
import { DomainError } from '../domain/errors.js';
import type { AgentId } from '../domain/contracts.js';
import {
  FrozenLaunch,
  INBOX_ATTEMPT_MS,
  wakePrompt,
  INBOX_CAPACITY,
  INBOX_HEARTBEAT_MS,
  Result,
  NativeTerminalNotice,
  clip,
  inboxIntent,
  stopIntent,
  resendIntent,
  type BlockedReason,
  type Claim,
  type DeliveryReason,
  spaceDirectory,
} from '../domain/inbox.js';
import type { Launch } from '../domain/execution.js';
import { WorkerBinding, type WorkerConfig } from './config.js';
import {
  agentTokenFile,
  managedDirectory,
  t3AuthFile,
  t3DeploymentFile,
} from './managed.js';
import type { BackendFactory } from './t3.js';
import {
  spacePlacer,
  spaceProvisioner,
  type FilePlacer,
  type Provisioner,
} from './space.js';
import {
  attachmentStore,
  storeConfig,
} from '../persistence/attachment-store.js';
import type { Readable } from 'node:stream';
import { posix } from 'node:path';

/**
 * Native read only. No tool/user text or synthetic status can become an
 * assistant result. A conversation's thread is read from `from`, the
 * position after its last published answer, so a long thread stays cheap.
 */
export async function assistantResult(
  backend: ExecutionBackend,
  reference: Reference,
  model: Observation['model'],
  signal: AbortSignal,
  from?: number,
): Promise<
  | { kind: 'result'; result: Result }
  | { kind: 'terminal-notice'; notice: NativeTerminalNotice }
  | {
      kind: 'waiting' | 'uncertain';
      reason: DeliveryReason;
      step?: Observation['step'];
    }
> {
  let after = from;
  let selected: Observation['history'][number] | undefined;
  let terminal: 'succeeded' | 'failed' | 'stopped' | undefined;
  for (let page = 0; page < 4; page++) {
    const observation = await backend.read(reference, after, signal);
    if (
      JSON.stringify(observation.reference) !== JSON.stringify(reference) ||
      observation.model.providerId !== model.providerId ||
      observation.model.modelId !== model.modelId
    )
      throw new ExecutionFailure('incompatible');
    if (observation.state === 'uncertain')
      return { kind: 'uncertain', reason: 'run-unobserved' };
    // pendingRequests are the exact Run's, or the whole thread's for a
    // reference naming none. A newer Run awaiting approval cannot keep an
    // older terminal Run's Inbox delivery blocked, or hide its real
    // assistant item.
    if (
      !observation.terminal ||
      (reference.runId === undefined && observation.pendingRequests > 0)
    )
      return {
        kind: 'waiting',
        reason:
          observation.state === 'waiting' || observation.pendingRequests > 0
            ? 'human-or-approval-wait'
            : 'execution-active',
        step: observation.step ?? null,
      };
    const state = observation.state;
    if (state !== 'succeeded' && state !== 'failed' && state !== 'stopped')
      return { kind: 'uncertain', reason: 'terminal-unmapped' };
    if (terminal !== undefined && terminal !== state)
      throw new ExecutionFailure('incompatible');
    terminal = state;
    for (const item of observation.history)
      if (
        item.runId === reference.runId &&
        item.type === 'assistant_message' &&
        item.text?.trim()
      )
        selected = item;
    if (!observation.hasMore) {
      if (
        !selected?.text &&
        reference.runId !== undefined &&
        (terminal === 'failed' || terminal === 'stopped')
      )
        return {
          kind: 'terminal-notice',
          notice: NativeTerminalNotice.parse({
            kind: 'native-terminal-no-assistant',
            reference,
            state: terminal,
          }),
        };
      if (!selected?.text || reference.runId === undefined)
        return { kind: 'waiting', reason: 'assistant-result-unavailable' };
      // T3's reply that doesn't fit the result Kinmesh posts reads no
      // better on the next attempt.
      const result = Result.safeParse({
        reference,
        itemId: selected.id,
        text: clip(selected.text, 6000),
        truncated: selected.truncated || selected.text.length > 6000,
        state: terminal,
        position: selected.position,
      });
      if (!result.success) throw new ExecutionFailure('unreadable');
      return { kind: 'result', result: result.data };
    }
    if (
      observation.nextPosition === null ||
      (after !== undefined && observation.nextPosition <= after)
    )
      return { kind: 'uncertain', reason: 'history-cursor-invalid' };
    after = observation.nextPosition;
  }
  return { kind: 'waiting', reason: 'history-page-bound' };
}
/**
 * Interrupts the delivery's run in T3 under its own journaled operation, so
 * T3 is asked once however often this is retried. The thread's queue goes
 * on: later messages to the agent are not held back. A thread deleted in T3
 * took the run with it.
 */
async function interrupt(
  backend: ExecutionBackend,
  reference: Reference,
  claim: Claim,
  signal: AbortSignal,
) {
  const intent = stopIntent(claim.agentId, claim.id);
  try {
    const stopped = await backend.stop(reference, intent, signal);
    if (stopped.kind === 'uncertain')
      await backend.reconcile(intent, stopped.operationId, signal);
  } catch (error) {
    if (!(error instanceof ExecutionFailure) || error.kind !== 'gone')
      throw error;
  }
}
/**
 * Sends the delivery's message again as a new turn in its thread, under its
 * own journaled operation, so it is sent once however often this is retried.
 * `queue` makes it a turn of its own: it never steers another run. A thread
 * deleted in T3 has nowhere to send it.
 */
async function resend(
  backend: ExecutionBackend,
  reference: Reference,
  message: string,
  claim: Claim,
  signal: AbortSignal,
): Promise<Reference | 'uncertain' | 'gone'> {
  const intent = resendIntent(claim.agentId, claim.id);
  const thread = {
    backend: 't3' as const,
    environmentId: reference.environmentId,
    threadId: reference.threadId,
  };
  try {
    let sent = await backend.send(thread, message, intent, signal, 'queue');
    if (sent.kind === 'uncertain')
      sent = await backend.reconcile(intent, sent.operationId, signal);
    return sent.kind === 'known' ? sent.reference : 'uncertain';
  } catch (error) {
    if (error instanceof ExecutionFailure && error.kind === 'gone')
      return 'gone';
    throw error;
  }
}
/** T3 answers from another environment than the one the agent was connected to. */
class EnvironmentChanged extends Error {
  override readonly name = 'EnvironmentChanged';
}
/** The run started under a credential or T3 authority the agent no longer has. */
class AuthorityChanged extends Error {
  override readonly name = 'AuthorityChanged';
}
/**
 * The team's T3 sign-in ended. Nothing is sent to T3 under it; the delivery
 * waits for a new sign-in, which is the same authority, so it goes on.
 */
export class SignInEnded extends Error {
  override readonly name = 'SignInEnded';
}
/** The worker doesn't serve the agent's newly chosen provider yet. */
class CatchingUp extends Error {
  override readonly name = 'CatchingUp';
}
/**
 * What T3's refusal says a person can fix: access, or the model the agent
 * runs. A conflict or rejected input names neither, so it stays unexplained.
 */
function nativeCause(failure: ExecutionFailure): BlockedReason {
  if (['permission', 'authentication'].includes(failure.kind))
    return 'native-access';
  if (failure.kind === 'unreadable') return 'native-unreadable';
  return failure.kind === 'incompatible'
    ? 'native-incompatible'
    : 'authority-or-contract-blocked';
}
export async function deliver(
  store: Store,
  claim: Claim,
  binding: WorkerBinding,
  factory: BackendFactory,
  stopping: AbortSignal,
  /** Makes a channel's folder in the space a T3 project; null: scratch threads. */
  space: Provisioner | null = null,
  /** Places a message's files in the channel's folder, from the store. */
  files: {
    place: FilePlacer;
    read: (sha256: string) => Promise<Readable>;
  } | null = null,
) {
  const signal = AbortSignal.any([
    stopping,
    AbortSignal.timeout(INBOX_ATTEMPT_MS),
  ]);
  let handle: Awaited<ReturnType<BackendFactory>> | undefined;
  let stage: 'authority' | 'connect' | 'execution' | 'publication' =
    'authority';
  try {
    if (binding.agentId !== claim.agentId) throw new DomainError('forbidden');
    const principal = await store.agents.resolveToken(
      loadAgentToken(binding.tokenFile),
    );
    const { profile, context } = await store.inbox.context(claim, principal);
    const preferences = profile.preferences;
    if (
      preferences.environmentId === null ||
      preferences.providerId === null ||
      preferences.modelId === null
    )
      throw new ExecutionFailure('incompatible');
    stage = 'connect';
    // A run that may already be in T3 finishes under the authority it
    // launched under, while T3 still honours a credential for it.
    const before = await store.inbox.get(claim.id);
    handle = await factory(
      binding,
      profile,
      signal,
      before.launch === null
        ? undefined
        : FrozenLaunch.parse(JSON.parse(before.launch)).execution.authority,
    );
    signal.throwIfAborted();
    if (handle.identity.endpoint !== binding.t3Endpoint)
      throw new ExecutionFailure('incompatible');
    if (handle.identity.environmentId !== preferences.environmentId)
      throw new EnvironmentChanged();
    const model = {
      providerId: preferences.providerId,
      modelId: preferences.modelId,
    };
    const execution = handle.identity;
    const backend = handle.backend;
    // The grant's ceiling, or the broadest mode below it the provider runs.
    const mode = backend.mode(model.providerId);
    // The agent's conversation in this topic (or in the channel outside
    // topics) continues in its thread,
    // unless the thread runs another model or runtime mode, lives under
    // another T3 authority, or is a scratch thread while the channel has a
    // project in the space: then this delivery starts a new one.
    const previous = await store.inbox.conversation(claim);
    const conversation =
      previous !== null &&
      JSON.stringify(previous.execution) === JSON.stringify(handle.identity) &&
      JSON.stringify(previous.model) === JSON.stringify(model) &&
      previous.mode === mode &&
      previous.target.kind === (space === null ? 'scratch' : 'project')
        ? previous.conversation
        : undefined;
    // A new thread starts in the channel's project: its folder in the space,
    // named once, which the provisioner makes a T3 project if it isn't one.
    const newTarget = async (): Promise<Launch['target']> => {
      if (space === null) return { kind: 'scratch' };
      const directory = await store.inbox.space(
        claim,
        spaceDirectory(context.channelName, claim.channelId),
      );
      const root = await space(directory, context.channelName, signal);
      const projectId = await backend.project(root, signal);
      if (projectId === null) throw new ExecutionFailure('incompatible');
      return { kind: 'project', projectId };
    };
    // A message's files are in the channel's folder before any agent it
    // wakes is sent to T3, so every thread of the channel finds them; the
    // turn says where. Without a space the turn says how to read them.
    // Placing again changes nothing, so every attempt does.
    const attached = context.message?.attachments ?? [];
    let placed: Record<string, string> | null = null;
    if (space !== null) {
      placed = {};
      if (attached.length > 0) {
        if (files === null) throw new ExecutionFailure('unavailable');
        const directory = await store.inbox.space(
          claim,
          spaceDirectory(context.channelName, claim.channelId),
        );
        const root = await space(directory, context.channelName, signal);
        for (const file of attached) {
          const { attachment, sha256 } = await store.communication.attachment(
            principal,
            claim.teamId,
            claim.channelId,
            file.id,
          );
          let body: Readable;
          try {
            body = await files.read(sha256);
          } catch {
            // The store no longer has them: placing again won't help.
            throw new ExecutionFailure('incompatible');
          }
          const path = await files.place(
            directory,
            file,
            { body, size: attachment.size, sha256 },
            signal,
          );
          placed[file.id] = posix.relative(root, path);
        }
      }
    }
    // A message to the conversation's thread goes where the thread is; a new
    // thread keeps the project it was frozen into, so a retry needs nothing
    // from the provisioner.
    const target = async (): Promise<Launch['target']> => {
      if (conversation !== undefined && previous !== null)
        return previous.target;
      const row = await store.inbox.get(claim.id);
      const pinned =
        row.launch === null ? null : FrozenLaunch.parse(JSON.parse(row.launch));
      if (
        pinned?.conversation === undefined &&
        pinned?.input.target.kind === (space === null ? 'scratch' : 'project')
      )
        return pinned.input.target;
      return newTarget();
    };
    const launch = (
      conversation: z.infer<typeof FrozenLaunch>['conversation'],
      target: Launch['target'],
    ) =>
      FrozenLaunch.parse({
        execution,
        grantId: principal.kind === 'agent' ? principal.grantId : '',
        input: {
          target,
          title: clip(
            `Kinmesh: ${profile.name} in #${context.channelName}` +
              (context.topic === null ? '' : ` / ${context.topic}`),
            200,
          ),
          mode,
          model,
          message: wakePrompt(
            context,
            profile.name,
            conversation === undefined,
            placed,
          ),
        },
        ...(conversation === undefined ? {} : { conversation }),
      });
    let frozen = await store.inbox
      .freeze(claim, principal, launch(conversation, await target()))
      .catch(async (error: unknown) => {
        // A run T3 may already have stays pinned to the credential and T3
        // authority it started under; after a reconnect it cannot publish.
        const row = await store.inbox.get(claim.id);
        const pinned =
          row.launch === null
            ? null
            : FrozenLaunch.parse(JSON.parse(row.launch));
        if (
          error instanceof DomainError &&
          error.kind === 'forbidden' &&
          pinned !== null &&
          (pinned.grantId !==
            (principal.kind === 'agent' ? principal.grantId : '') ||
            JSON.stringify(pinned.execution) !==
              JSON.stringify(handle?.identity))
        )
          throw new AuthorityChanged();
        throw error;
      });
    let row = await store.inbox.get(claim.id);
    // A model chosen since freezing applies only to a run T3 can't have yet
    // (freeze froze it again); a dispatched one keeps the model it started
    // with. Until the worker serves the new provider, a fresh launch waits.
    if (
      row.operationId === null &&
      row.reference === null &&
      frozen.input.model.providerId !== binding.isolatedProviderId
    )
      throw new CatchingUp();
    stage = 'execution';
    signal.throwIfAborted();
    // Crash before remember() re-enters the SAME frozen intent; T3Backend returns its durable journal outcome.
    if (row.reference === null) {
      const intent = inboxIntent(claim.agentId, claim.id);
      // A person stopped it before it reached T3: it ends here.
      if (row.operationId === null && !(await store.inbox.launching(claim)))
        return;
      // A message to a busy thread steers its running turn instead of
      // waiting behind it.
      let dispatch: Dispatch;
      try {
        dispatch =
          row.operationId !== null
            ? await handle.backend.reconcile(intent, row.operationId, signal)
            : frozen.conversation === undefined
              ? await handle.backend.launch(frozen.input, intent, signal)
              : await handle.backend.send(
                  {
                    backend: 't3',
                    environmentId: preferences.environmentId,
                    threadId: frozen.conversation.threadId,
                  },
                  frozen.input.message ?? '',
                  intent,
                  signal,
                  'auto',
                );
      } catch (error) {
        // Someone deleted the conversation's thread in T3: the message
        // starts a new one.
        if (
          frozen.conversation === undefined ||
          !(error instanceof ExecutionFailure && error.kind === 'gone')
        )
          throw error;
        frozen = await store.inbox.restart(
          claim,
          principal,
          launch(undefined, await newTarget()),
        );
        dispatch = await handle.backend.launch(frozen.input, intent, signal);
      }
      if (dispatch.kind === 'uncertain') {
        await store.inbox.remember(claim, {
          operationId: dispatch.operationId,
        });
        // T3 answered, but not as the contract says: reconciling gets the
        // same answer, so the delivery stops with the cause. Its retry
        // reconciles under the same request key; nothing is sent twice.
        if (
          dispatch.reason === 'incompatible' ||
          dispatch.reason === 'unreadable'
        )
          throw new ExecutionFailure(dispatch.reason);
        await store.inbox.defer(claim, 'uncertain', 'native-launch-uncertain');
        return;
      }
      if (
        dispatch.reference.environmentId !== preferences.environmentId ||
        !dispatch.reference.runId
      )
        throw new ExecutionFailure('incompatible');
      await store.inbox.remember(
        claim,
        dispatch.reference,
        dispatch.delivery === 'steered',
      );
      row = await store.inbox.get(claim.id);
    }
    let reference = Reference.parse(JSON.parse(row.reference ?? ''));
    if (reference.environmentId !== preferences.environmentId)
      throw new ExecutionFailure('incompatible');
    // A person asked to stop it: its run is interrupted, and reading on
    // posts how it ended, once T3 says it has.
    if (row.stopRequestedAt !== null)
      await interrupt(handle.backend, reference, claim, signal);
    const observe = (reference: Reference) =>
      assistantResult(
        backend,
        reference,
        frozen.input.model,
        signal,
        frozen.conversation?.afterPosition ?? undefined,
      ).catch((error: unknown) => {
        // Its thread was deleted in T3, and the run with it.
        if (
          error instanceof ExecutionFailure &&
          error.kind === 'gone' &&
          reference.runId !== undefined
        )
          return {
            kind: 'terminal-notice' as const,
            gone: true,
            notice: NativeTerminalNotice.parse({
              kind: 'native-terminal-no-assistant',
              reference,
              state: 'stopped',
            }),
          };
        throw error;
      });
    let result = await observe(reference);
    // Its message steered a run that then stopped: T3 lost the message with
    // the run, so it is sent again as a turn of its own, unless a person
    // asked to stop it.
    if (
      row.steered &&
      row.stopRequestedAt === null &&
      !('gone' in result) &&
      (result.kind === 'result'
        ? result.result.state === 'stopped'
        : result.kind === 'terminal-notice' &&
          result.notice.state === 'stopped')
    ) {
      const again = await resend(
        backend,
        reference,
        frozen.input.message ?? '',
        claim,
        signal,
      );
      if (again === 'uncertain') {
        await store.inbox.defer(claim, 'uncertain', 'native-launch-uncertain');
        return;
      }
      if (again !== 'gone') {
        if (
          again.environmentId !== preferences.environmentId ||
          again.threadId !== reference.threadId ||
          !again.runId
        )
          throw new ExecutionFailure('incompatible');
        await store.inbox.resent(claim, again);
        reference = again;
        result = await observe(reference);
      }
    }
    if ('reason' in result) {
      await store.inbox.defer(
        claim,
        result.kind,
        result.reason,
        'step' in result ? (result.step ?? null) : null,
      );
      return;
    }
    stage = 'publication';
    signal.throwIfAborted();
    // Resolve again immediately before the fenced transaction; scopes/grant/assignment are rechecked inside it.
    const current = await store.agents.resolveToken(
      loadAgentToken(binding.tokenFile),
    );
    await store.inbox.ack(
      claim,
      current,
      result.kind === 'terminal-notice' ? result.notice : result.result,
    );
  } catch (error) {
    const blocked =
      error instanceof EnvironmentChanged ||
      error instanceof AuthorityChanged ||
      (error instanceof DomainError && error.kind !== 'conflict') ||
      // Data that doesn't fit a contract doesn't fit on the next attempt.
      error instanceof z.ZodError ||
      // Nor does a publication the database's rules refuse.
      (stage === 'publication' && refused(error)) ||
      (error instanceof ExecutionFailure &&
        [
          'permission',
          'authentication',
          'incompatible',
          'unreadable',
          'conflict',
          'invalid-input',
        ].includes(error.kind));
    try {
      const reason: DeliveryReason | BlockedReason = blocked
        ? error instanceof EnvironmentChanged
          ? 'environment-changed'
          : error instanceof AuthorityChanged
            ? 'authority-changed'
            : error instanceof ExecutionFailure
              ? nativeCause(error)
              : await store.inbox.blockedCause(claim, () =>
                  loadAgentToken(binding.tokenFile),
                )
        : error instanceof CatchingUp
          ? 'setup-catching-up'
          : error instanceof SignInEnded
            ? 'sign-in-expired'
            : stopping.aborted
              ? 'worker-stopping'
              : 'temporarily-unavailable';
      await store.inbox.defer(
        claim,
        blocked ? 'blocked' : stage === 'execution' ? 'uncertain' : 'ready',
        reason,
      );
    } catch {
      // Expired/superseded lease: never overwrite the successor. The persisted intent remains recoverable.
    }
  } finally {
    try {
      await handle?.close();
    } catch {
      /* Connection cleanup cannot alter delivery outcome. */
    }
  }
}
/** Ordinary independently supervised process loop, sharing SQLite capacity/leases across processes. */
/** Bindings for agents the owner connected from the workspace. */
export async function managedBindings(
  store: Store,
  directory: string,
): Promise<WorkerBinding[]> {
  return (await store.managed.workerBindings()).map((b) =>
    WorkerBinding.parse({
      agentId: b.agentId,
      tokenFile: agentTokenFile(directory, b.agentId),
      t3Endpoint: b.endpoint,
      t3AuthFile: t3AuthFile(directory),
      t3FallbackAuthFile: t3DeploymentFile(directory),
      isolatedProviderId: b.providerId,
    }),
  );
}
export async function runWorker(
  store: Store,
  config: WorkerConfig,
  factory: BackendFactory,
  stopping: AbortSignal,
  onReady?: () => Promise<void>,
) {
  const stopped = () => stopping.aborted;
  let initialized = false;
  const running = new Set<Promise<void>>();
  const directory = managedDirectory(config.state);
  const space = config.space === null ? null : spaceProvisioner(config.space);
  // The files people attached are in the store the hub was given.
  const files =
    config.space === null
      ? null
      : {
          place: spacePlacer(config.space),
          read: attachmentStore(storeConfig(process.env)).read,
        };
  let bindings = new Map<AgentId, WorkerBinding>();
  let lastBeat = 0;
  try {
    while (!stopped()) {
      // Agents connected from the workspace join or leave without a restart;
      // a binding in the operator's configuration wins over a managed one.
      const next = new Map(
        (await managedBindings(store, directory)).map((b) => [b.agentId, b]),
      );
      for (const b of config.bindings) next.set(b.agentId, b);
      const gone = [...bindings.keys()].filter((id) => !next.has(id));
      if (gone.length > 0) await store.inbox.release(gone);
      // New or removed agents show their state now, not at the next beat.
      if (gone.length > 0 || [...next.keys()].some((id) => !bindings.has(id)))
        lastBeat = 0;
      bindings = next;
      if (Date.now() - lastBeat >= INBOX_HEARTBEAT_MS) {
        await store.inbox.heartbeat([...bindings.keys()]);
        lastBeat = Date.now();
      }
      while (running.size < INBOX_CAPACITY && bindings.size > 0 && !stopped()) {
        const claim = await store.inbox.claim([...bindings.keys()]);
        if (!claim) break;
        const binding = bindings.get(claim.agentId);
        if (!binding) throw new Error('Unknown binding');
        const work = deliver(
          store,
          claim,
          binding,
          factory,
          stopping,
          space,
          files,
        ).finally(() => {
          running.delete(work);
        });
        running.add(work);
      }
      if (!initialized) {
        await onReady?.();
        initialized = true;
      }
      try {
        await delay(config.pollMs, undefined, { signal: stopping });
      } catch {
        if (!stopped()) throw new Error('Worker timer failed');
      }
    }
  } finally {
    await Promise.allSettled(running);
    try {
      await store.inbox.release([...bindings.keys()]);
    } catch {
      // Liveness goes stale on its own if the database is already gone.
    }
  }
}
