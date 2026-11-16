import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { Descriptor } from '../adapters/t3/contracts.js';
import {
  Endpoint,
  loadCredential,
  saveCredential,
  signInEnded,
} from '../adapters/t3/oauth.js';
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
/**
 * A session the deployment issued lasts only while the deployment provides
 * it. A hub it no longer connects ends that session, so agents wait for a
 * person's sign-in instead of running on a session nobody renews. A person's
 * sign-in, which carries its OAuth client, is left as it is.
 */
export function endProvisionedT3(directory: string, now = Date.now()) {
  const file = t3AuthFile(directory);
  if (!existsSync(file)) return false;
  const { endpoint } = z
    .object({ endpoint: Endpoint })
    .parse(JSON.parse(readFileSync(file, 'utf8')));
  const credential = loadCredential(file, endpoint);
  if (credential.client !== undefined || signInEnded(credential, now))
    return false;
  saveCredential(
    file,
    { ...credential, expiresAt: new Date(now).toISOString() },
    { replace: true },
  );
  return true;
}
