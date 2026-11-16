import type { z } from 'zod';
import { ExecutionFailure, Reference } from '../domain/execution.js';
import {
  Descriptor,
  Read,
  ValidatedTools,
  selectRun,
} from '../adapters/t3/contracts.js';
import { Endpoint, type Credential } from '../adapters/t3/oauth.js';
import { threadLink } from './links.js';
import { SdkWire } from '../adapters/t3/sdk.js';
import { NativeObservation } from './contracts.js';

type ExecutionReference = z.infer<typeof Reference>;

/**
 * Where the T3 serving this endpoint shows the thread: on the endpoint's own
 * origin, never a link from T3's read, which may point anywhere (T3 0.1.9
 * links its hosted app whichever T3 serves the thread).
 */
export function verifiedNativeLink(
  endpoint: string,
  reference: ExecutionReference,
): string | null {
  const authority = Endpoint.safeParse(endpoint);
  return authority.success
    ? threadLink(new URL(authority.data).origin, reference)
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
  const { status, terminal, providerId, modelId } = selectRun(read, ref.runId);
  return NativeObservation.parse({
    source: 't3-native-verified',
    observedAt,
    reference: ref,
    status,
    terminal,
    threadPendingRequests: read.thread.pendingRequestCount,
    providerId,
    modelId,
    verifiedUrl: verifiedNativeLink(endpoint, ref),
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
