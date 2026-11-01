import { Capabilities, ValidatedTools } from './contracts.js';
import type { Credential } from './oauth.js';
import { SdkWire } from './sdk.js';

/** What T3 offers for an agent's runtime, so the owner picks instead of types. */
export async function t3Providers(credential: Credential, signal: AbortSignal) {
  const wire = new SdkWire(credential, { signal });
  try {
    const tools = new ValidatedTools(wire, await wire.list(), [
      'orchestrator_capabilities',
    ]);
    const capabilities = Capabilities.parse(
      await tools.call('orchestrator_capabilities', {}, signal, 8000),
    );
    return capabilities.providers.map((p) => ({
      id: p.providerInstanceId,
      models: p.models.map((m) => m.id),
    }));
  } finally {
    await wire.close();
  }
}
export type T3Providers = typeof t3Providers;
