import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Descriptor } from './contracts.js';
import { Endpoint } from './oauth.js';
import { verifiedOAuthMetadata } from './metadata.js';

export const PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 65_536;
const RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const METADATA_PATH = '/.well-known/oauth-authorization-server';
const DESCRIPTOR_PATH = '/.well-known/t3/environment';
const SCOPES = ['orchestration:read', 'orchestration:operate'];
const rejected = () => new Error('T3 preflight rejected');

/** Bound bytes before SDK JSON parsing; the fetch signal also bounds stalled bodies. */
async function boundedBody(response: Response, signal: AbortSignal) {
  if (!response.body) throw rejected();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw rejected();
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

/**
 * No credential input/output. Only public, unauthenticated GETs to fixed T3 paths.
 * A shorter deadline is allowed for tests; callers cannot extend the 10-second ceiling.
 */
export async function preflight(
  endpoint: string,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
): Promise<void> {
  const stop = new AbortController();
  const timer = setTimeout(
    () => {
      stop.abort();
    },
    Number.isFinite(timeoutMs)
      ? Math.max(1, Math.min(timeoutMs, PREFLIGHT_TIMEOUT_MS))
      : 1,
  );
  const state = { failed: false };
  const seen = new Set<string>();
  try {
    const origin = new URL(Endpoint.parse(endpoint)).origin;
    const paths = new Set([
      '/mcp',
      DESCRIPTOR_PATH,
      RESOURCE_PATH + '/mcp',
      RESOURCE_PATH,
      METADATA_PATH,
    ]);
    const fetchFn: FetchLike = async (input, init) => {
      try {
        stop.signal.throwIfAborted();
        if (state.failed || input instanceof Request) throw rejected();
        const raw = String(input);
        const url = new URL(raw);
        if (
          url.href !== raw ||
          /[\\?#\s]/u.test(raw) ||
          url.origin !== origin ||
          url.username ||
          url.password ||
          !paths.has(url.pathname) ||
          seen.has(url.pathname) ||
          (init?.method !== undefined && init.method !== 'GET') ||
          init?.body != null
        )
          throw rejected();
        seen.add(url.pathname);
        // Rebuild the request; never inherit headers, credentials or a cookie jar.
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            accept:
              url.pathname === '/mcp'
                ? 'application/json, text/event-stream'
                : 'application/json',
          },
          credentials: 'omit',
          redirect: 'manual',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          signal: stop.signal,
        });
        if (url.pathname === '/mcp') {
          await response.body?.cancel();
          if (
            response.status !== 401 ||
            !/^Bearer(?:[ \t]+[^\r\n]+)?$/i.test(
              response.headers.get('www-authenticate') ?? '',
            )
          )
            throw rejected();
          return new Response(null, { status: 401 });
        }
        // Only the standard path-aware protected-resource 404 may fall back to root.
        if (
          response.status === 404 &&
          url.pathname === RESOURCE_PATH + '/mcp'
        ) {
          await response.body?.cancel();
          return new Response(null, { status: 404 });
        }
        if (
          response.status !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get('content-type') ?? '',
          )
        ) {
          await response.body?.cancel();
          throw rejected();
        }
        return new Response(await boundedBody(response, stop.signal), {
          headers: { 'content-type': 'application/json' },
        });
      } catch {
        // SDK discovery catches some errors: poison subsequent fallback attempts too.
        state.failed = true;
        throw rejected();
      }
    };
    await fetchFn(endpoint);
    const descriptor: unknown = await (
      await fetchFn(origin + DESCRIPTOR_PATH)
    ).json();
    const parsed = Descriptor.parse(descriptor);
    if (parsed.environmentId.trim() !== parsed.environmentId) throw rejected();
    const discovered = await discoverOAuthServerInfo(endpoint, { fetchFn });
    if (state.failed) throw rejected();
    const { metadata, resource } = verifiedOAuthMetadata(endpoint, discovered);
    if (
      !metadata.response_types_supported.includes('code') ||
      !metadata.grant_types_supported?.includes('authorization_code') ||
      !metadata.token_endpoint_auth_methods_supported?.includes('none') ||
      !resource.bearer_methods_supported?.includes('header') ||
      SCOPES.some(
        (scope) =>
          !metadata.scopes_supported?.includes(scope) ||
          !resource.scopes_supported?.includes(scope),
      )
    )
      throw rejected();
    stop.signal.throwIfAborted();
  } catch {
    throw rejected();
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
}
