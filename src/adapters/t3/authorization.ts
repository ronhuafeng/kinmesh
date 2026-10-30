import { createServer } from 'node:http';
import { z } from 'zod';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { randomBytes } from 'node:crypto';
import { Descriptor } from './contracts.js';
import { Credential, Endpoint } from './oauth.js';

export const CALLBACK = 'http://127.0.0.1:49871/callback';
export const AUTH_TIMEOUT_MS = 180_000;
const SCOPE = 'orchestration:read orchestration:operate';
const MAX_URL = 8192;
const rejected = () => new Error('Authorization input rejected');

/** No user-controlled URL or Zod diagnostics escape this sensitive boundary. */
export function callbackCode(input: string, state: string, issuer: string) {
  try {
    if (
      input.length > MAX_URL ||
      !input.startsWith(CALLBACK + '?') ||
      /[\s\\#\x00-\x1f\x7f]/.test(input)
    )
      throw rejected();
    const url = new URL(input);
    const keys = [...url.searchParams.keys()];
    if (
      url.origin !== new URL(CALLBACK).origin ||
      url.pathname !== '/callback' ||
      url.username ||
      url.password ||
      keys.length !== 3 ||
      url.search.slice(1).split('&').length !== 3 ||
      new Set(keys).size !== 3 ||
      keys.some((key) => !['state', 'code', 'iss'].includes(key)) ||
      url.searchParams.get('state') !== state ||
      url.searchParams.get('iss') !== issuer
    )
      throw rejected();
    const code = url.searchParams.get('code');
    if (!code || !/^[A-Za-z0-9_-]{1,2048}$/.test(code)) throw rejected();
    return code;
  } catch {
    throw rejected();
  }
}

/** One-shot receiver, also used by the browser-local flow. Caller owns listen/close. */
export function callbackReceiver(
  state: string,
  issuer: string,
  signal: AbortSignal,
) {
  let consumed = false;
  let accept: (code: string) => void = () => {
    throw rejected();
  };
  let refuse: () => void = () => {
    throw rejected();
  };
  const code = new Promise<string>((done, reject) => {
    accept = done;
    refuse = () => {
      reject(rejected());
    };
  });
  // A disconnect/deadline can precede discovery completion; consume early rejection safely.
  void code.catch(() => {
    /* The original promise is still awaited by the authorization flow. */
  });
  signal.addEventListener('abort', refuse, { once: true });
  if (signal.aborted) refuse();
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 5000 },
    (request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('referrer-policy', 'no-referrer');
      try {
        if (
          consumed ||
          signal.aborted ||
          request.method !== 'GET' ||
          request.headers.host !== '127.0.0.1:49871'
        )
          throw rejected();
        const value = callbackCode(
          'http://127.0.0.1:49871' + (request.url ?? ''),
          state,
          issuer,
        );
        consumed = true;
        response
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('Authorization received. Return to your terminal.');
        accept(value);
      } catch {
        response.writeHead(400).end('Authorization callback rejected');
      }
    },
  );
  server.maxConnections = 4;
  server.keepAliveTimeout = 1000;
  server.once('close', () => {
    signal.removeEventListener('abort', refuse);
  });
  return { server, code };
}

/** Auth discovery/exchange may contact only the pinned T3 origin; never follow redirects. */
export function authorizationFetch(
  endpoint: string,
  signal: AbortSignal,
  transport: FetchLike = fetch,
): FetchLike {
  const origin = new URL(Endpoint.parse(endpoint)).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin || url.username || url.password || url.hash)
      throw rejected();
    signal.throwIfAborted();
    const inherited =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    const response = await transport(input, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(10000),
        ...(inherited ? [inherited] : []),
      ]),
    });
    // Prevent SDK retries of a rejected/expired code and any redirect to another issuer.
    if (
      (response.status >= 300 && response.status < 400) ||
      (method.toUpperCase() !== 'GET' && !response.ok)
    )
      throw rejected();
    return response;
  };
}

function checkedAuthorizationUrl(
  url: URL,
  expected: {
    endpoint: string;
    authorization: string;
    state: string;
    clientId: string;
  },
) {
  const keys = [...url.searchParams.keys()];
  if (
    url.href.length > MAX_URL ||
    url.origin + url.pathname !== expected.authorization ||
    url.username ||
    url.password ||
    url.hash ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (k) =>
        ![
          'response_type',
          'client_id',
          'redirect_uri',
          'scope',
          'state',
          'resource',
          'code_challenge',
          'code_challenge_method',
        ].includes(k),
    ) ||
    url.searchParams.get('response_type') !== 'code' ||
    url.searchParams.get('client_id') !== expected.clientId ||
    url.searchParams.get('redirect_uri') !== CALLBACK ||
    url.searchParams.get('state') !== expected.state ||
    url.searchParams.get('scope') !== SCOPE ||
    url.searchParams.get('resource') !== expected.endpoint ||
    url.searchParams.get('code_challenge_method') !== 'S256' ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '')
  )
    throw rejected();
}

export interface AuthorizationInteraction {
  /** Receives a validated URL; manual implementation must write only to its private TTY. */
  redirect(url: URL, signal: AbortSignal): Promise<void>;
  prepare(
    state: string,
    issuer: string,
    signal: AbortSignal,
  ): Promise<{ code: Promise<string> }>;
}

async function beforeAbort<T>(work: Promise<T>, signal: AbortSignal) {
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((done, reject) => {
      abort = () => {
        reject(rejected());
      };
      signal.addEventListener('abort', abort, { once: true });
      void work.then(done, reject);
      if (signal.aborted) abort();
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** Official SDK owns discovery, DCR, S256 PKCE and token exchange; this owns validation/UI only. */
export async function authorize(
  endpoint: string,
  interaction: AuthorizationInteraction,
  signal: AbortSignal,
  transport: FetchLike = fetch,
): Promise<Credential> {
  try {
    Endpoint.parse(endpoint);
    const issuer = new URL(endpoint).origin;
    const fetchFn = authorizationFetch(endpoint, signal, transport);
    const discovered = await discoverOAuthServerInfo(endpoint, { fetchFn });
    const metadata = discovered.authorizationServerMetadata;
    const resource = discovered.resourceMetadata;
    if (
      !metadata ||
      !resource ||
      discovered.authorizationServerUrl !== issuer ||
      metadata.issuer !== issuer ||
      resource.resource !== endpoint ||
      resource.authorization_servers?.length !== 1 ||
      resource.authorization_servers[0] !== issuer ||
      !metadata.code_challenge_methods_supported?.includes('S256') ||
      !z
        .object({
          authorization_response_iss_parameter_supported: z.literal(true),
        })
        .safeParse(metadata).success
    )
      throw rejected();
    for (const [field, path] of [
      [metadata.authorization_endpoint, '/oauth/mcp/authorize'],
      [metadata.token_endpoint, '/oauth/mcp/token'],
      [metadata.registration_endpoint, '/oauth/mcp/register'],
    ] as const)
      if (field !== issuer + path) throw rejected();
    const descriptor = Descriptor.parse(
      await (
        await fetchFn(new URL('/.well-known/t3/environment', endpoint))
      ).json(),
    );
    const state = randomBytes(32).toString('hex');
    let verifier = '';
    let client: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    // Install callback handling before presenting/opening the URL, so local redirects cannot race it.
    const { code: received } = await interaction.prepare(state, issuer, signal);
    void received.catch(() => {
      /* Awaited below, never logged. */
    });
    const provider: OAuthClientProvider = {
      redirectUrl: CALLBACK,
      clientMetadata: {
        client_name: 'Kinmesh external T3 adapter',
        redirect_uris: [CALLBACK],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      state: () => state,
      discoveryState: () => ({
        authorizationServerUrl: discovered.authorizationServerUrl,
        authorizationServerMetadata: metadata,
        resourceMetadata: resource,
      }),
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
        if (!client) throw rejected();
        checkedAuthorizationUrl(url, {
          endpoint,
          authorization: metadata.authorization_endpoint,
          state,
          clientId: client.client_id,
        });
        await beforeAbort(interaction.redirect(url, signal), signal);
      },
    };
    if (
      (await auth(provider, { serverUrl: endpoint, scope: SCOPE, fetchFn })) !==
      'REDIRECT'
    )
      throw rejected();
    const code = await beforeAbort(received, signal);
    signal.throwIfAborted();
    if (
      (await auth(provider, {
        serverUrl: endpoint,
        authorizationCode: code,
        scope: SCOPE,
        fetchFn,
      })) !== 'AUTHORIZED' ||
      !client ||
      !tokens
    )
      throw rejected();
    signal.throwIfAborted();
    const current = Descriptor.parse(
      await (
        await fetchFn(new URL('/.well-known/t3/environment', endpoint))
      ).json(),
    );
    if (current.environmentId !== descriptor.environmentId) throw rejected();
    return Credential.parse({
      endpoint,
      environmentId: descriptor.environmentId,
      client,
      tokens,
    });
  } catch {
    throw new Error('Owner authorization failed; restart with a fresh request');
  }
}
