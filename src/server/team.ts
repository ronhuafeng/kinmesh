import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import { humanOf } from './principals.js';

/** The team a person belongs to, and the channels they are in. */
export function registerTeam(app: FastifyInstance, store: Store) {
  app.get('/api/team', async (request, reply) => {
    const team = await store.teamFor(humanOf(request));
    return team ?? reply.code(403).send({ error: 'Membership required' });
  });
}
