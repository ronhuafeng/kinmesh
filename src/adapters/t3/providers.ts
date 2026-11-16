import { Capabilities, ValidatedTools, launchMode } from './contracts.js';
import type { Credential } from './oauth.js';
import { SdkWire } from './sdk.js';

/** What T3 offers for an agent's runtime, so the owner picks instead of types. */
export async function t3Providers(credential: Credential, signal: AbortSignal) {
  const wire = new SdkWire(credential, { signal });
  try {
    const tools = new ValidatedTools(wire, await wire.list(), [
      'orchestrator_capabilities',
    ]);
    // The caller's signal is the one deadline.
    const capabilities = Capabilities.parse(
      await tools.call('orchestrator_capabilities', {}, signal),
    );
    // Only what a wake can actually run on: a provider switched off in T3,
    // one without models, or one that runs no mode a launch may use, is
    // never offered.
    return capabilities.providers
      .filter(
        (p) =>
          launchMode(p, capabilities.runtimeMode) !== null &&
          p.models.length > 0,
      )
      .map((p) => ({
        id: p.providerInstanceId,
        models: p.models.map((m) => m.id),
      }));
  } finally {
    await wire.close();
  }
}
export type T3Providers = typeof t3Providers;
/**
 * The grant's ceiling: the mode the person chose on T3's approval page, and
 * the broadest any run launches in. It is fixed for the grant.
 */
export async function t3Ceiling(credential: Credential, signal: AbortSignal) {
  const wire = new SdkWire(credential, { signal });
  try {
    const tools = new ValidatedTools(wire, await wire.list(), [
      'orchestrator_capabilities',
    ]);
    return Capabilities.parse(
      await tools.call('orchestrator_capabilities', {}, signal),
    ).runtimeMode;
  } finally {
    await wire.close();
  }
}
export type T3Ceiling = typeof t3Ceiling;
