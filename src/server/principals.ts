import type { FastifyRequest } from 'fastify';
import { IdentityError, type Principal } from '../domain/agents.js';
import type { Store } from '../persistence/store.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
/** The caller the protected API resolved for this request. */
export function principal(request: FastifyRequest) {
  if (request.principal === null) throw new IdentityError(401);
  return request.principal;
}

/** Only call with credentials from the verified session plugin or HTTP Authorization.
 * Actor labels, role messages and tool arguments are never credential inputs. */
export function resolvePrincipal(
  store: Store,
  authorization: string | undefined,
  sessionToken: unknown,
): Principal {
  if (authorization !== undefined) {
    // Reject mixed authority rather than silently choosing the more privileged principal.
    if (sessionToken !== undefined) throw new IdentityError(400);
    const bearer = /^Bearer (kma_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    if (bearer === undefined) throw new IdentityError(401);
    return store.agents.resolveToken(bearer);
  }
  // A session lives on the server: revoked, idle or too old, it ends here.
  const humanId = store.sessions.resolve(sessionToken, Date.now());
  if (humanId === undefined) throw new IdentityError(401);
  return { kind: 'human', humanId };
}
