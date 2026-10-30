import type { ExecutionBinding } from '../domain/inbox.js';
import type { Agent } from '../domain/agents.js';
import {
  ExecutionFailure,
  type ExecutionBackend,
} from '../domain/execution.js';
import { T3Backend } from '../adapters/t3/backend.js';
import { SdkWire } from '../adapters/t3/sdk.js';
import { authority, loadCredential } from '../adapters/t3/oauth.js';
import type { Store } from '../persistence/store.js';
import type { Binding } from './config.js';
export type BackendFactory = (
  binding: Binding,
  profile: Agent,
  signal: AbortSignal,
) => Promise<{
  backend: ExecutionBackend;
  identity: ExecutionBinding;
  close: () => Promise<void>;
}>;
export function t3Factory(store: Store): BackendFactory {
  return async (binding, profile, signal) => {
    signal.throwIfAborted();
    const credential = loadCredential(binding.t3AuthFile, binding.t3Endpoint);
    if (
      profile.preferences.environmentId !== credential.environmentId ||
      profile.preferences.providerId !== binding.isolatedProviderId ||
      profile.preferences.modelId === null
    )
      throw new ExecutionFailure('incompatible');
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
}
