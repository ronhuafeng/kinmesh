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
  client: OAuthClientInformationSchema,
  tokens: OAuthTokensSchema,
});
export type Credential = z.infer<typeof Credential>;
function approvedScopes(credential: Credential) {
  const scopes = credential.tokens.scope?.split(/\s+/) ?? [];
  if (
    credential.tokens.token_type.toLowerCase() !== 'bearer' ||
    !scopes.includes('orchestration:read') ||
    scopes.some(
      (scope) =>
        !['orchestration:read', 'orchestration:operate'].includes(scope),
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
export function authority(credential: Credential) {
  return createHash('sha256')
    .update(credential.tokens.access_token)
    .digest('hex');
}
export function storedProvider(credential: Credential): OAuthClientProvider {
  return {
    redirectUrl: 'http://127.0.0.1:49871/callback',
    clientMetadata: {
      client_name: 'Kinmesh external T3 adapter',
      redirect_uris: ['http://127.0.0.1:49871/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
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
