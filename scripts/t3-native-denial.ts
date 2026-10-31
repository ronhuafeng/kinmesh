import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Wire } from '../src/adapters/t3/contracts.js';

// Genuine T3 MCP error envelope. Neither a local authorization exception nor
// a generic network failure proves that the native server denied a mutation.
const NativeCapabilityDenial = z.object({
  isError: z.literal(true),
  structuredContent: z.object({
    code: z.literal('capability_denied'),
  }),
});
const TextErrorEnvelope = z.object({
  isError: z.literal(true),
  structuredContent: z.undefined().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

/** Test-only, harmless denial probe for an explicitly approved Read only grant.
 * This intentionally bypasses Kinmesh's local T3Backend scope guard and
 * does not depend on a scope-filtered tools/list exposing write descriptors.
 */
export async function nativeReadOnlyDenial(
  wire: Pick<Wire, 'call'>,
): Promise<boolean> {
  const response = await wire.call('t3_thread_organize', {
    threadId: randomUUID(),
    action: 'archive',
  });
  if (NativeCapabilityDenial.safeParse(response).success) return true;
  const envelope = TextErrorEnvelope.safeParse(response);
  if (!envelope.success) return false;
  const text = envelope.data.content.find((item) => item.type === 'text')?.text;
  try {
    const structuredContent: unknown = JSON.parse(text ?? '');
    return NativeCapabilityDenial.safeParse({
      isError: true,
      structuredContent,
    }).success;
  } catch {
    return false;
  }
}
