import type { ExecutionBinding } from '../domain/inbox.js';
import type { Agent } from '../domain/agents.js';
import {
  ExecutionFailure,
  type ExecutionBackend,
} from '../domain/execution.js';
import { T3Backend } from '../adapters/t3/backend.js';
import { SdkWire } from '../adapters/t3/sdk.js';
import {
  authority,
  chooseCredential,
  credentialIn,
  endCredential,
  signInEnded,
  type Credential,
} from '../adapters/t3/oauth.js';
import type { Store } from '../persistence/store.js';
import type { WorkerBinding } from './config.js';
import { SignInEnded } from './worker.js';
export type BackendFactory = (
  binding: WorkerBinding,
  profile: Agent,
  signal: AbortSignal,
  /** The T3 authority a run that may already be in T3 launched under. */
  pinned?: string,
) => Promise<{
  backend: ExecutionBackend;
  identity: ExecutionBinding;
  close: () => Promise<void>;
}>;
/**
 * The credential the binding's runs use now, and its file: the broadest T3
 * honours, or the one a run under way launched under while it is honoured.
 * Without any usable file T3 can't be reached at all; with only ended ones
 * the delivery waits for a new sign-in.
 */
export function runCredential(
  binding: WorkerBinding,
  pinned?: string,
  now = Date.now(),
): { credential: Credential; file: string } {
  const files = [binding.t3AuthFile];
  if (binding.t3FallbackAuthFile !== undefined)
    files.push(binding.t3FallbackAuthFile);
  const loaded = files.map((file) => ({
    file,
    credential: credentialIn(file, binding.t3Endpoint),
  }));
  if (loaded.every((l) => l.credential === null))
    throw new ExecutionFailure('authentication');
  const chosen = chooseCredential(
    loaded.map((l) => l.credential),
    pinned,
    now,
  );
  const found = loaded.find((l) => chosen !== null && l.credential === chosen);
  if (chosen === null || found === undefined) throw new SignInEnded();
  return { credential: chosen, file: found.file };
}
/** Whether the binding has a credential T3 honours besides `credential`. */
function another(binding: WorkerBinding, credential: Credential) {
  return [binding.t3AuthFile, binding.t3FallbackAuthFile].some((file) => {
    if (file === undefined) return false;
    const other = credentialIn(file, binding.t3Endpoint);
    return (
      other !== null &&
      other.tokens.access_token !== credential.tokens.access_token &&
      !signInEnded(other)
    );
  });
}
export function t3Factory(store: Store): BackendFactory {
  const connect = async (credential: Credential, signal: AbortSignal) => {
    const wire = new SdkWire(credential);
    try {
      const discovered = await wire.list().catch((error: unknown) => {
        if (error instanceof ExecutionFailure) throw error;
        throw new ExecutionFailure('unavailable');
      });
      // Preserve transport failures as retryable even during discovery; connect still validates the native contract.
      const backend = await T3Backend.connect(
        {
          list: () => Promise.resolve(discovered),
          call: (...args) => wire.call(...args),
          close: () => wire.close(),
        },
        store.operations,
        {
          endpoint: credential.endpoint,
          expectedEnvironmentId: credential.environmentId,
          authority: authority(credential),
          scopes: credential.tokens.scope?.split(/\s+/) ?? [],
        },
      );
      signal.throwIfAborted();
      return {
        backend,
        identity: {
          endpoint: credential.endpoint,
          environmentId: credential.environmentId,
          authority: authority(credential),
        },
        close: () => wire.close(),
      };
    } catch (error) {
      await wire.close();
      throw error;
    }
  };
  return async (binding, _profile, signal, pinned) => {
    signal.throwIfAborted();
    // The worker holds the profile to this credential's environment and the binding's provider.
    const { credential, file } = runCredential(binding, pinned);
    try {
      return await connect(credential, signal);
    } catch (error) {
      // T3 refuses a credential it revoked. With another one it honours,
      // this one ends and the other runs; alone, its refusal stands.
      if (
        !(error instanceof ExecutionFailure) ||
        error.kind !== 'authentication' ||
        !another(binding, credential) ||
        !endCredential(file, credential)
      )
        throw error;
      return connect(runCredential(binding, pinned).credential, signal);
    }
  };
}
