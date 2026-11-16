import {
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  fstatSync,
  closeSync,
  constants,
  linkSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  OAuthTokensSchema,
  OAuthClientInformationSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { ExecutionFailure } from '../../domain/execution.js';
import { RUNTIME_MODES } from './contracts.js';

export const Endpoint = z
  .string()
  .refine((value) => value === value.trim())
  .pipe(z.url())
  .refine((value) => {
    const u = new URL(value);
    return (
      u.href === value &&
      !/[\\?#\s]/u.test(value) &&
      u.pathname === '/mcp' &&
      u.search === '' &&
      u.hash === '' &&
      u.username === '' &&
      u.password === '' &&
      (u.protocol === 'https:' ||
        (u.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
    );
  });
export const Credential = z.object({
  endpoint: Endpoint,
  environmentId: z.string().min(1),
  /** The OAuth client of a person's sign-in; a token the deployment issues has none. */
  client: OAuthClientInformationSchema.optional(),
  tokens: OAuthTokensSchema,
  /**
   * When T3 stops honouring the token, as T3 said when it issued it; absent
   * when T3 didn't say. T3 issues no refresh token, so a person signs in again.
   */
  expiresAt: z.iso.datetime().optional(),
  /**
   * The grant's ceiling, which the person chose on T3's approval page, as T3
   * reported it at sign-in; absent when it wasn't read.
   */
  ceiling: z.enum(RUNTIME_MODES).optional(),
});
export type Credential = z.infer<typeof Credential>;
/** From this long before a sign-in ends, the workspace asks to reconnect T3. */
export const RENEW_BEFORE_MS = 7 * 86400_000;
/** Whether T3 no longer honours this credential. */
export function signInEnded(credential: Credential, now = Date.now()) {
  return (
    credential.expiresAt !== undefined &&
    Date.parse(credential.expiresAt) <= now
  );
}
/** The T3 scopes Kinmesh asks for; a credential holds read and nothing else. */
export const ORCHESTRATION_SCOPES: readonly string[] = [
  'orchestration:read',
  'orchestration:operate',
];
/**
 * What T3 grants besides operate when a person approves Full access. A
 * credential may hold them only with operate, and nothing else beyond.
 */
export const FULL_ACCESS_SCOPES: readonly string[] = [
  'settings:write',
  'source-control:write',
];
/** The fixed loopback OAuth redirect and the public client it registers. */
export const CALLBACK = 'http://127.0.0.1:49871/callback';
export const CLIENT_METADATA = {
  client_name: 'Kinmesh external T3 adapter',
  redirect_uris: [CALLBACK],
  grant_types: ['authorization_code'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
function approvedScopes(credential: Credential) {
  const scopes = credential.tokens.scope?.split(/\s+/) ?? [];
  const operate = scopes.includes('orchestration:operate');
  if (
    credential.tokens.token_type.toLowerCase() !== 'bearer' ||
    !scopes.includes('orchestration:read') ||
    scopes.some(
      (scope) =>
        !ORCHESTRATION_SCOPES.includes(scope) &&
        !(operate && FULL_ACCESS_SCOPES.includes(scope)),
    )
  )
    throw new ExecutionFailure('authentication');
}
export function loadCredential(path: string, endpoint: string): Credential {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (stat.mode & 0o177) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error('Unsafe credential file');
    const data = Credential.parse(JSON.parse(readFileSync(fd, 'utf8')));
    if (data.endpoint !== Endpoint.parse(endpoint))
      throw new Error('Wrong endpoint');
    approvedScopes(data);
    return data;
  } catch {
    throw new ExecutionFailure('authentication');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
/** The credential in `path` for `endpoint`, or null when none is usable there. */
export function credentialIn(path: string, endpoint: string) {
  try {
    return loadCredential(path, endpoint);
  } catch {
    return null;
  }
}
/** How far runs under a credential may go: its ceiling, or nothing beyond reading. */
function breadth(credential: Credential) {
  if (!credential.tokens.scope?.split(/\s+/).includes('orchestration:operate'))
    return -1;
  // A ceiling that wasn't read is taken as the narrowest a run may launch in.
  return RUNTIME_MODES.indexOf(credential.ceiling ?? 'approval-required');
}
/**
 * The credential agents' runs use, among those T3 still honours, listed most
 * preferred first (a person's sign-in, then the deployment's session): the
 * broadest, the earlier when equal. A run that may already be in T3 keeps the
 * authority it launched under (`pinned`) while a credential for it is
 * honoured. Null when T3 honours none of them.
 */
export function chooseCredential(
  candidates: readonly (Credential | null)[],
  pinned?: string,
  now = Date.now(),
): Credential | null {
  const honoured = candidates.filter(
    (c): c is Credential => c !== null && !signInEnded(c, now),
  );
  const kept = honoured.find((c) => authority(c) === pinned);
  if (kept !== undefined) return kept;
  return honoured.reduce<Credential | null>(
    (best, c) => (best === null || breadth(c) > breadth(best) ? c : best),
    null,
  );
}
/**
 * T3 refused this credential (it was revoked): it reads as ended from now,
 * unless the file meanwhile holds another one. Returns whether it was ended.
 */
export function endCredential(
  path: string,
  credential: Credential,
  now = Date.now(),
) {
  const current = credentialIn(path, credential.endpoint);
  if (
    current?.tokens.access_token !== credential.tokens.access_token ||
    signInEnded(current, now)
  )
    return false;
  saveCredential(
    path,
    { ...current, expiresAt: new Date(now).toISOString() },
    { replace: true },
  );
  return true;
}
export function credentialDestination(path: string, replace = false) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path));
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    realpathSync(dirname(path)) !== resolve(dirname(path))
  )
    throw new ExecutionFailure('authentication');
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (
    file &&
    (!replace ||
      !file.isFile() ||
      file.uid !== process.getuid() ||
      (file.mode & 0o177) !== 0)
  )
    throw new ExecutionFailure('authentication');
}
export function saveCredential(
  path: string,
  value: Credential,
  options: { replace: boolean } = { replace: true },
) {
  const data = Credential.parse(value);
  approvedScopes(data);
  credentialDestination(path, options.replace);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    if (options.replace) renameSync(temporary, path);
    else linkSync(temporary, path); // Atomic no-overwrite publication for a newly approved CLI grant.
  } finally {
    rmSync(temporary, { force: true });
  }
}
/**
 * Who Kinmesh acts as in T3: this endpoint and environment, with these
 * scopes. A new token for the same (a renewed or reissued grant) is the same
 * authority, so work under way continues; another environment or other
 * scopes are another authority.
 */
export function authority(credential: Credential) {
  const scopes = [...new Set(credential.tokens.scope?.split(/\s+/) ?? [])]
    .filter(Boolean)
    .sort();
  return createHash('sha256')
    .update(
      JSON.stringify([credential.endpoint, credential.environmentId, scopes]),
    )
    .digest('hex');
}
export function storedProvider(credential: Credential): OAuthClientProvider {
  return {
    redirectUrl: CALLBACK,
    clientMetadata: CLIENT_METADATA,
    clientInformation: () => credential.client,
    tokens: () => credential.tokens,
    saveTokens: () => {
      throw new ExecutionFailure('authentication');
    },
    redirectToAuthorization: () => {
      throw new ExecutionFailure('authentication');
    },
    saveCodeVerifier: () => {
      throw new ExecutionFailure('authentication');
    },
    codeVerifier: () => {
      throw new ExecutionFailure('authentication');
    },
  };
}
