import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import open from 'open';
import {
  auth,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import { Endpoint, saveCredential } from '../src/adapters/t3/oauth.js';

process.umask(0o077);
const config = z
  .object({
    KINMESH_T3_ENDPOINT: Endpoint,
    KINMESH_T3_AUTH_FILE: z.string().min(1),
  })
  .safeParse(process.env);
if (!config.success) {
  console.error('T3_AUTH FAIL: configure endpoint and private auth file.');
  process.exitCode = 1;
} else {
  const server = createServer();
  try {
    server.listen(49871, '127.0.0.1');
    await once(server, 'listening');
    const state = randomBytes(32).toString('hex');
    let verifier = '';
    let client: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let acceptCode: ((code: string) => void) | undefined;
    const codeReceived = new Promise<string>((resolve, reject) => {
      acceptCode = resolve;
      const timeout = setTimeout(() => {
        reject(new Error('Approval timeout'));
      }, 180000);
      timeout.unref();
    });
    const endpoint = config.data.KINMESH_T3_ENDPOINT;
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1:49871');
      if (
        request.method !== 'GET' ||
        url.pathname !== '/callback' ||
        url.searchParams.get('state') !== state ||
        url.searchParams.get('iss') !== new URL(endpoint).origin ||
        !url.searchParams.has('code')
      ) {
        response.writeHead(400).end('Authorization callback rejected');
        return;
      }
      response
        .writeHead(200, {
          'content-type': 'text/plain',
          'cache-control': 'no-store',
        })
        .end('Authorization received. Return to your terminal.');
      acceptCode?.(z.string().min(1).parse(url.searchParams.get('code')));
    });
    const redirect = 'http://127.0.0.1:49871/callback';
    const provider: OAuthClientProvider = {
      redirectUrl: redirect,
      clientMetadata: {
        client_name: 'Kinmesh external T3 adapter',
        redirect_uris: [redirect],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      state: () => state,
      clientInformation: () => client,
      saveClientInformation: (value) => {
        client = value;
      },
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      redirectToAuthorization: async (url) => {
        await open(url.href, { wait: false });
      },
    };
    if ((await auth(provider, { serverUrl: endpoint })) !== 'REDIRECT')
      throw new Error('No redirect');
    console.info(
      'Approve the sign-in in your local browser. Choose Read only or Supervised; no URL or credential is printed.',
    );
    const code = await codeReceived;
    if (
      (await auth(provider, {
        serverUrl: endpoint,
        authorizationCode: code,
      })) !== 'AUTHORIZED' ||
      client === undefined ||
      tokens === undefined
    )
      throw new Error('Not authorized');
    const descriptor = z
      .object({
        environmentId: z.string().min(1),
        serverVersion: z.literal('0.1.5'),
      })
      .parse(
        await (
          await fetch(new URL('/.well-known/t3/environment', endpoint), {
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          })
        ).json(),
      );
    saveCredential(config.data.KINMESH_T3_AUTH_FILE, {
      endpoint,
      environmentId: descriptor.environmentId,
      client,
      tokens,
    });
    console.info('T3_AUTH PASS: private OAuth credentials saved.');
  } catch {
    console.error(
      'T3_AUTH FAIL: owner approval or local browser/callback unavailable.',
    );
    process.exitCode = 1;
  } finally {
    server.close();
  }
}
