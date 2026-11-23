import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';

/** Signing out here: the session ends, and the browsers it turned notifications on in. */
export function registerLogout(app: FastifyInstance, store: Store) {
  app.post('/api/logout', async (request, reply) => {
    await store.browsers.signedOut(request.session.get('session'));
    await store.sessions.revoke(request.session.get('session'), Date.now());
    request.session.delete();
    return reply.code(204).send();
  });
}
