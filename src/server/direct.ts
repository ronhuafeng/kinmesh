import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TeamId } from '../domain/contracts.js';
import { DirectInput } from '../domain/communication.js';
import type { Store } from '../persistence/store.js';
import { principal } from './principals.js';
const TeamPath = z.object({ teamId: TeamId });
/** Two people's own conversation, opened by one of them. */
export function registerDirect(app: FastifyInstance, store: Store) {
  /** A person opens their own conversation with another; the answer is its channel. */
  app.post('/api/teams/:teamId/direct', async (request) =>
    store.channels.direct(
      principal(request),
      TeamPath.parse(request.params).teamId,
      DirectInput.parse(request.body),
    ),
  );
}
