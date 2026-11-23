import { existsSync, readFileSync, renameSync } from 'node:fs';
import { z } from 'zod';
import { Descriptor } from '../adapters/t3/contracts.js';
import {
  Credential,
  Endpoint,
  loadCredential,
  saveCredential,
  signInEnded,
} from '../adapters/t3/oauth.js';
import { t3Ceiling, type T3Ceiling } from '../adapters/t3/providers.js';
import {
  privateDirectory,
  t3AuthFile,
  t3DeploymentFile,
} from '../runtime/managed.js';
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
 * A session T3 issued (`t3 auth session issue --json`) as a credential for
 * the T3 at `endpoint`, which names its environment.
 */
export async function issuedCredential(
  raw: string,
  endpoint: string,
  fetchFn: typeof fetch = fetch,
) {
  const issued = Issued.parse(JSON.parse(raw));
  const response = await fetchFn(
    new URL('/.well-known/t3/environment', endpoint),
    { redirect: 'error', signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throw new Error('T3 environment unavailable');
  const { environmentId } = Descriptor.parse(await response.json());
  return Credential.parse({
    endpoint,
    environmentId,
    tokens: {
      access_token: issued.token,
      token_type: 'Bearer',
      scope: issued.scopes.join(' '),
    },
    ...(issued.expiresAt === undefined
      ? {}
      : { expiresAt: new Date(issued.expiresAt).toISOString() }),
  });
}
/**
 * The T3 the deployment connects: the session T3 issued for the hub, in a
 * file the deployment keeps current. Each sync that finds it changed asks
 * T3 which environment it is and the session's ceiling, stores it where the
 * worker reads it, beside any person's sign-in, and records the team's
 * connection. A renewed session is the same authority, so work under way
 * goes on.
 */
export function provisionedT3(
  store: Store,
  directory: string,
  t3: { endpoint: string; credentialFile: string },
  fetchFn: typeof fetch = fetch,
  ceiling: T3Ceiling = t3Ceiling,
) {
  let applied: string | null = null;
  return async function sync() {
    const raw = readFileSync(t3.credentialFile, 'utf8');
    if (raw === applied) return false;
    const credential = await issuedCredential(raw, t3.endpoint, fetchFn);
    const { environmentId } = credential;
    // How far its runs may go, so a person's broader sign-in is preferred
    // and the workspace says how agents run; the session stands without it.
    const mode = await ceiling(credential, AbortSignal.timeout(10_000)).catch(
      () => undefined,
    );
    privateDirectory(directory);
    saveCredential(
      t3DeploymentFile(directory),
      mode === undefined ? credential : { ...credential, ceiling: mode },
      { replace: true },
    );
    // Before anyone has signed in there is no team yet: try again later.
    if ((await store.managed.provision(t3.endpoint, environmentId)) === 0)
      return false;
    applied = raw;
    return true;
  };
}
/** The credential a file holds, for whichever endpoint it names. */
function stored(file: string) {
  const { endpoint } = z
    .object({ endpoint: Endpoint })
    .parse(JSON.parse(readFileSync(file, 'utf8')));
  return loadCredential(file, endpoint);
}
/**
 * A session the deployment issued is kept apart from a person's sign-in.
 * One found where a person's sign-in goes (it carries no OAuth client, as a
 * person's does) moves to the deployment's file.
 */
export function separateDeploymentSession(directory: string) {
  const file = t3AuthFile(directory);
  if (!existsSync(file) || stored(file).client !== undefined) return false;
  renameSync(file, t3DeploymentFile(directory));
  return true;
}
/**
 * A session the deployment issued lasts only while the deployment provides
 * it. A hub it no longer connects ends that session, so agents run under a
 * person's sign-in, or wait for one, instead of on a session nobody renews.
 */
export function endProvisionedT3(directory: string, now = Date.now()) {
  const file = t3DeploymentFile(directory);
  if (!existsSync(file)) return false;
  const credential = stored(file);
  if (signInEnded(credential, now)) return false;
  saveCredential(
    file,
    { ...credential, expiresAt: new Date(now).toISOString() },
    { replace: true },
  );
  return true;
}
