import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HumanId } from '../domain/contracts.js';
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
/**
 * What a session remembers of the password it was signed in with. Changing
 * the password changes it, which ends every other session.
 */
export function credentialMark(passwordHash: string) {
  return createHash('sha256').update(passwordHash).digest('base64url');
}
export function resolvePrincipal(
  store: Store,
  authorization: string | undefined,
  sessionHumanId: unknown,
  sessionMark?: unknown,
): Principal {
  const human = HumanId.safeParse(sessionHumanId);
  if (authorization !== undefined) {
    // Reject mixed authority rather than silently choosing the more privileged principal.
    if (human.success) throw new IdentityError(400);
    const bearer = /^Bearer (kma_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    if (bearer === undefined) throw new IdentityError(401);
    return store.agents.resolveToken(bearer);
  }
  if (!human.success) throw new IdentityError(401);
  const hash = store.passwordHash(human.data);
  if (hash === undefined || sessionMark !== credentialMark(hash))
    throw new IdentityError(401);
  return { kind: 'human', humanId: human.data };
}
