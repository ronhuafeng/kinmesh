import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { normalizeIP } from '@fastify/rate-limit';

/** The client's address as limits count it: an IPv6 /64 is one client. */
export const clientAddress = (request: FastifyRequest) =>
  normalizeIP(request.ip);

/**
 * Whose pace a request counts against. A signed-in session counts by itself,
 * so people behind one address (an office, a VPN) each keep their own. Its
 * cookie is sealed with the hub's session key: nobody can make up sessions
 * to multiply a budget, and no lookup is needed to tell. Whether the session
 * still lives is the route's to decide. Everything else counts against the
 * client's address: nobody signed in, and an agent's bearer, which anyone
 * can make up.
 */
export function limitKey(request: FastifyRequest) {
  const session = request.session.get('session');
  return typeof session === 'string'
    ? 'session:' + createHash('sha256').update(session).digest('base64url')
    : clientAddress(request);
}

/**
 * The built assets are immutable files browsers keep for a year; serving
 * them reads no data, so they count against nobody.
 */
export const unlimited = (request: FastifyRequest) =>
  request.routeOptions.url?.startsWith('/assets/') === true;
