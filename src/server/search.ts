import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TeamId } from '../domain/contracts.js';
import type { Store } from '../persistence/store.js';
import { principal } from './principals.js';

/** What a person finds by typing: messages and files in the channels they are in. */
export function registerSearch(app: FastifyInstance, store: Store) {
  /**
   * What a person types in search, found in the channels they are in:
   * messages whose text holds it and files whose name does, newest first.
   */
  app.get('/api/teams/:teamId/search', async (request) => {
    const { teamId } = z.object({ teamId: TeamId }).parse(request.params);
    const { q } = z
      .strictObject({ q: z.string().trim().min(2).max(100) })
      .parse(request.query);
    const p = principal(request);
    const [messages, files] = await Promise.all([
      store.messages.searchMessages(p, teamId, q),
      store.files.files(p, teamId, null, 10, null, q),
    ]);
    return { messages, files: files.items };
  });
}
