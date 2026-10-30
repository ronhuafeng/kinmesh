import {
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  OAuthTokensSchema,
  OAuthClientInformationSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { ExecutionFailure } from '../../domain/execution.js';

export const Endpoint = z.url().refine((value) => {
  const u = new URL(value);
  return (
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
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error('Unsafe credential file');
    const data = Credential.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (data.endpoint !== Endpoint.parse(endpoint))
      throw new Error('Wrong endpoint');
    approvedScopes(data);
    return data;
  } catch {
    throw new ExecutionFailure('authentication');
  }
}
export function saveCredential(path: string, value: Credential) {
  const data = Credential.parse(value);
  approvedScopes(data);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
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
