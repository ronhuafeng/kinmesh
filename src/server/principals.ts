import type { FastifyRequest } from 'fastify';
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
