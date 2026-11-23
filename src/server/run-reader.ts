import type { z } from 'zod';
import type { TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import type { Reference } from '../domain/execution.js';
import type { Store } from '../persistence/store.js';
import type { Credential } from '../adapters/t3/oauth.js';
import { readNativeExecution } from '../workspace/native.js';

type Person = Extract<Principal, { kind: 'human' }>;
/**
 * Reads a run through the team's T3 connection, the one its agents' runs
 * use now (`runCredential`).
 */
export function runReader(
  store: Store,
  runCredential: (endpoint: string) => Credential | null,
) {
  /** One read of a run through the team's T3 connection, the one runs use. */
  return async function readRun(
    principal: Person,
    teamId: TeamId,
    reference: z.infer<typeof Reference>,
  ) {
    const connection = await store.t3Connections.teamConnection(
      principal,
      teamId,
    );
    if (!connection) throw new Error('Unavailable');
    const credential = runCredential(connection.endpoint);
    if (credential?.environmentId !== reference.environmentId)
      throw new Error('Unavailable');
    return readNativeExecution(
      credential,
      reference,
      AbortSignal.timeout(8000),
    );
  };
}
export type ReadRun = ReturnType<typeof runReader>;
