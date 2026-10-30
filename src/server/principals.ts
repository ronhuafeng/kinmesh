import { HumanId } from '../domain/contracts.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import type { Store } from '../persistence/store.js';

/** Only call with credentials from the verified session plugin or HTTP Authorization.
 * Actor labels, role messages and tool arguments are never credential inputs. */
export function resolvePrincipal(
  store: Store,
  authorization: string | undefined,
  sessionHumanId: unknown,
): Principal {
  const human = HumanId.safeParse(sessionHumanId);
  if (authorization !== undefined) {
    // Reject mixed authority rather than silently choosing the more privileged principal.
    if (human.success) throw new IdentityError(400);
    const bearer = /^Bearer (kma_[A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    if (bearer === undefined) throw new IdentityError(401);
    return store.agents.resolveToken(bearer);
  }
  if (!human.success || store.human(human.data) === undefined)
    throw new IdentityError(401);
  return { kind: 'human', humanId: human.data };
}
