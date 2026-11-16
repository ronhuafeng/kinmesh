import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Descriptor } from '../adapters/t3/contracts.js';
import { saveCredential } from '../adapters/t3/oauth.js';
import { privateDirectory, t3AuthFile } from '../inbox/managed.js';
import type { Store } from '../persistence/store.js';

/** What `t3 auth session issue --json` prints; only these fields are kept. */
const Issued = z
  .object({
    token: z.string().min(1),
    scopes: z.array(z.string().min(1)).min(1),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .loose();

/**
 * The T3 the deployment connects: the session T3 issued for the hub, in a
 * file the deployment keeps current. Each sync that finds it changed asks
 * T3 which environment it is, stores the credential where the worker reads
 * it, and records the team's connection. A renewed session is the same
 * authority, so work under way goes on.
 */
export function provisionedT3(
  store: Store,
  directory: string,
  t3: { endpoint: string; credentialFile: string },
  fetchFn: typeof fetch = fetch,
) {
  let applied: string | null = null;
  return async function sync() {
    const raw = readFileSync(t3.credentialFile, 'utf8');
    if (raw === applied) return false;
    const issued = Issued.parse(JSON.parse(raw));
    const response = await fetchFn(
      new URL('/.well-known/t3/environment', t3.endpoint),
      { redirect: 'error', signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error('T3 environment unavailable');
    const { environmentId } = Descriptor.parse(await response.json());
    privateDirectory(directory);
    saveCredential(
      t3AuthFile(directory),
      {
        endpoint: t3.endpoint,
        environmentId,
        tokens: {
          access_token: issued.token,
          token_type: 'Bearer',
          scope: issued.scopes.join(' '),
        },
        ...(issued.expiresAt === undefined
          ? {}
          : { expiresAt: new Date(issued.expiresAt).toISOString() }),
      },
      { replace: true },
    );
    // Before anyone has signed in there is no team yet: try again later.
    if ((await store.managed.provision(t3.endpoint, environmentId)) === 0)
      return false;
    applied = raw;
    return true;
  };
}
