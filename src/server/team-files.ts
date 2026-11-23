import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChannelId, TeamId } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import { principal } from './principals.js';

/** The files of every channel a person is in, newest first. */
export function registerTeamFiles(app: FastifyInstance, store: Store) {
  // The files of every channel the person is in, newest first.
  app.get('/api/teams/:teamId/files', async (request) => {
    const { teamId } = z.object({ teamId: TeamId }).parse(request.params);
    const { before, channelId } = z
      .strictObject({
        before: z.coerce.number().int().positive().optional(),
        channelId: ChannelId.optional(),
      })
      .parse(request.query);
    return store.files.files(
      principal(request),
      teamId,
      before ?? null,
      50,
      channelId ?? null,
    );
  });
}
