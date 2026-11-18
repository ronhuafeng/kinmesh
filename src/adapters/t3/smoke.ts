import {
  Capabilities,
  Descriptor,
  EXECUTION_TOOLS,
  OPTIONAL_TOOLS,
  ValidatedTools,
  launchMode,
  type Wire,
} from './contracts.js';
import type { Credential } from './oauth.js';
import { ExecutionFailure } from '../../domain/execution.js';

/** Explicit read-only probe. A granted operate scope is reported, never exercised. */
export async function readSmoke(wire: Wire, credential: Credential) {
  // A read-only OAuth grant may discover only readable MCP tools. Never
  // require launch/send/interrupt descriptors merely to inspect the environment.
  const operate =
    credential.tokens.scope?.split(/\s+/).includes('orchestration:operate') ??
    false;
  const listed = await wire.list();
  // An operate grant runs agents: every tool a run uses must be there and
  // read as Kinmesh reads it, as a run would find it (none is called).
  if (operate)
    new ValidatedTools(wire, listed, EXECUTION_TOOLS, OPTIONAL_TOOLS);
  const tools = new ValidatedTools(wire, listed, [
    't3_environment_read',
    'orchestrator_capabilities',
  ]);
  const descriptor = Descriptor.parse(
    await tools.call('t3_environment_read', {}),
  );
  if (descriptor.environmentId !== credential.environmentId)
    throw new ExecutionFailure('incompatible');
  const capabilities = Capabilities.parse(
    await tools.call('orchestrator_capabilities', {}),
  );
  // The grant's ceiling is the person's choice in T3; Kinmesh launches each
  // run in it, or the broadest mode below it that the provider runs.
  const ceiling = capabilities.runtimeMode;
  const modes = capabilities.providers.flatMap((p) => {
    const mode = launchMode(p, ceiling);
    return mode === null ? [] : [{ providerId: p.providerInstanceId, mode }];
  });
  return { operate, ceiling, modes };
}
