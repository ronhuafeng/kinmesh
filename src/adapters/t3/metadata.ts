import { z } from 'zod';
import type { OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { Endpoint } from './oauth.js';

/** Shared identity/PKCE checks; this does not register, authorize or request scopes. */
export function verifiedOAuthMetadata(
  endpoint: string,
  discovered: OAuthServerInfo,
) {
  const issuer = new URL(Endpoint.parse(endpoint)).origin;
  const metadata = discovered.authorizationServerMetadata;
  const resource = discovered.resourceMetadata;
  const rejected = () => new Error('T3 OAuth metadata rejected');
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
  return { metadata, resource };
}
