import type { z } from 'zod';
import { ExecutionFailure, Reference } from '../domain/execution.js';
import { Descriptor, Read, ValidatedTools } from '../adapters/t3/contracts.js';
import { Endpoint, type Credential } from '../adapters/t3/oauth.js';
import { nativeThreadUrl } from './links.js';
import { SdkWire } from '../adapters/t3/sdk.js';
import { NativeObservation } from './contracts.js';

type ExecutionReference = z.infer<typeof Reference>;

/**
 * A link is presented only when the actual native read supplied the documented
 * outside-OAuth-client URL on the same trusted T3 origin for the exact thread.
 * Never make up deep links from IDs or accept external/untrusted redirects.
 */
export function verifiedNativeLink(
  candidate: unknown,
  endpoint: string,
  reference: ExecutionReference,
): string | null {
  const link = nativeThreadUrl(candidate, reference);
  if (!link) return null;
  const authority = Endpoint.safeParse(endpoint);
  return authority.success &&
    new URL(link).origin === new URL(authority.data).origin
    ? link
    : null;
}

/** Project only the requested Run's native state, not the thread's other Runs. */
export function projectNativeRead(
  raw: unknown,
  reference: ExecutionReference,
  endpoint: string,
  observedAt = new Date().toISOString(),
): NativeObservation {
  const read = Read.parse(raw);
  const ref = Reference.parse(reference);
  if (read.thread.threadId !== ref.threadId)
    throw new ExecutionFailure('incompatible');
  const run =
    ref.runId === undefined
      ? undefined
      : read.recentRuns.find((item) => item.runId === ref.runId);
  const status =
    ref.runId === undefined
      ? read.thread.status
      : (run?.status ?? 'unobserved');
  return NativeObservation.parse({
    source: 't3-native-verified',
    observedAt,
    reference: ref,
    status,
    terminal: [
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'rolled_back',
    ].includes(status),
    threadPendingRequests: read.thread.pendingRequestCount,
    providerId:
      ref.runId === undefined
        ? read.thread.providerInstanceId
        : (run?.providerInstanceId ?? null),
    modelId: ref.runId === undefined ? read.thread.model : (run?.model ?? null),
    verifiedUrl: verifiedNativeLink(read.thread.link, endpoint, ref),
  });
}

/**
 * Read-only external MCP over the user's separately authorized owner credential.
 * This service does not start, send, approve, interrupt or retry any Run.
 */
export async function readNativeExecution(
  credential: Credential,
  reference: ExecutionReference,
  signal?: AbortSignal,
): Promise<NativeObservation> {
  const ref = Reference.parse(reference);
  if (credential.environmentId !== ref.environmentId)
    throw new ExecutionFailure('incompatible');
  const wire = new SdkWire(credential, {
    readOnly: true,
    ...(signal ? { signal } : {}),
  });
  try {
    const tools = new ValidatedTools(wire, await wire.list(), [
      't3_environment_read',
      't3_thread_read',
    ]);
    const descriptor = Descriptor.parse(
      await tools.call('t3_environment_read', {}, signal),
    );
    if (descriptor.environmentId !== ref.environmentId)
      throw new ExecutionFailure('incompatible');
    const read = await tools.call(
      't3_thread_read',
      {
        threadId: ref.threadId,
        view: 'messages',
        limit: 1,
        runLimit: 50,
        maxCharsPerItem: 1,
      },
      signal,
    );
    return projectNativeRead(read, ref, credential.endpoint);
  } finally {
    await wire.close();
  }
}
