import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HumanId, TeamId } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import { principal } from './principals.js';
import { picture } from './picture.js';

const TeamPath = z.object({ teamId: TeamId });
const PersonPath = TeamPath.extend({ humanId: HumanId });
/** The people of the team, as Feishu shows them. */
export function registerPeople(app: FastifyInstance, store: Store) {
  // A person's picture, as Feishu last gave it: for the people of the team.
  app.get(
    '/api/teams/:teamId/people/:humanId/avatar',
    async (request, reply) => {
      const { teamId, humanId } = PersonPath.parse(request.params);
      return picture(
        reply,
        await store.portrait(principal(request), teamId, humanId),
      );
    },
  );
}
