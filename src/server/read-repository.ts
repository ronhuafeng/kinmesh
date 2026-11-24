import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChannelId, TeamId } from '../domain/contracts.js';
import { DomainError } from '../domain/errors.js';
import { RepositoryRead } from '../domain/repository.js';
import { TaskId } from '../domain/tasks.js';
import type { Store } from '../persistence/store.js';
import { readRepository } from '../adapters/github/contents.js';
import { principal } from './principals.js';

const TaskPath = z.object({
  teamId: TeamId,
  channelId: ChannelId,
  taskId: TaskId,
});

/**
 * The agent working on a task reads the repository it changes with the
 * team's app: a file's text or a directory's entries. No person's GitHub
 * identity is used, and the app's token never leaves the hub.
 */
export function registerReadRepository(
  app: FastifyInstance,
  store: Store,
  github: {
    api: string;
    /** The installation's token; null while no GitHub is connected. */
    token: () => Promise<string | null>;
  },
) {
  app.post(
    '/api/teams/:teamId/channels/:channelId/tasks/:taskId/read-repository',
    async (request) => {
      const { teamId, channelId, taskId } = TaskPath.parse(request.params);
      const p = principal(request);
      const read = z.strictObject(RepositoryRead).parse(request.body);
      // Only the agent the task is with: reading serves its work on it.
      const task = await store.tasks.get(p, teamId, channelId, taskId);
      const owner = task.state.owner;
      if (
        p.kind !== 'agent' ||
        owner?.kind !== 'agent' ||
        owner.id !== p.agentId
      )
        throw new DomainError('forbidden');
      const token = await github.token();
      if (token === null)
        throw new DomainError('conflict', { reason: 'github-not-connected' });
      return readRepository(github.api, token, read);
    },
  );
}
