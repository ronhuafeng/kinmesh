import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from '../persistence/store.js';
import { resolvePrincipal } from '../persistence/principals.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
/** The caller the protected API resolved for this request. */
export function principal(request: FastifyRequest) {
  if (request.principal === null) throw new DomainError('unauthenticated');
  return request.principal;
}
/** The person calling: an agent is refused. */
export function humanOf(request: FastifyRequest) {
  const p = principal(request);
  if (p.kind !== 'human') throw new DomainError('forbidden');
  return p.humanId;
}
/**
 * Every API request is someone's: the session or bearer credential resolves
 * to the caller, and only teams' routes take an agent.
 */
export function registerPrincipals(app: FastifyInstance, store: Store) {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    // GitHub's returns come from its site without the session cookie
    // (SameSite=Strict); they answer to the note the hub signed instead.
    if (request.url.startsWith('/api/github/')) {
      request.principal = null;
      return;
    }
    request.principal = await resolvePrincipal(
      store,
      request.headers.authorization,
      request.session.get('session'),
    );
    if (
      !request.url.startsWith('/api/teams/') &&
      request.principal.kind !== 'human'
    )
      return reply.code(403).send({ error: 'Human authentication required' });
  });
}
