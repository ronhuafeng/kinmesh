import {
  Capabilities,
  Descriptor,
  ValidatedTools,
  type Wire,
} from './contracts.js';
import type { Credential } from './oauth.js';
import { ExecutionFailure } from '../../domain/execution.js';

/** Explicit read-only probe. A granted operate scope is reported, never exercised. */
export async function readSmoke(wire: Wire, credential: Credential) {
  const tools = new ValidatedTools(wire, await wire.list());
  const descriptor = Descriptor.parse(
    await tools.call('t3_environment_read', {}),
  );
  if (descriptor.environmentId !== credential.environmentId)
    throw new ExecutionFailure('incompatible');
  const capabilities = Capabilities.parse(
    await tools.call('orchestrator_capabilities', {}),
  );
  const operate =
    credential.tokens.scope?.split(/\s+/).includes('orchestration:operate') ??
    false;
  if (operate && capabilities.runtimeMode !== 'approval-required')
    throw new ExecutionFailure('permission');
  return { operate };
}
