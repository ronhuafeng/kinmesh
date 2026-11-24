import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChannelId, TeamId } from '../domain/contracts.js';
import { DomainError } from '../domain/errors.js';
import { OpenPullRequest, TaskCommand, TaskId } from '../domain/tasks.js';
import type { Store } from '../persistence/store.js';
import { openPullRequest } from '../adapters/github/changes.js';
import { principal } from './principals.js';

const TaskPath = z.object({
  teamId: TeamId,
  channelId: ChannelId,
  taskId: TaskId,
});
/** A change carries up to 1 MiB of text; JSON escapes may grow it. */
const BODY_LIMIT = 2 * 1024 * 1024;

/**
 * The agent working on a task has Kinmesh open its change as a pull
 * request: Kinmesh makes the branch, the commit and the pull request on
 * GitHub with the team's app, saying whose change and which task it is,
 * then links it to the task. No person's GitHub identity is used.
 */
export function registerOpenPullRequest(
  app: FastifyInstance,
  store: Store,
  github: {
    api: string;
    /** The installation's token; null while no GitHub is connected. */
    token: () => Promise<string | null>;
    /** The workspace's origin, for the task's address. */
    origin: string;
  },
) {
  app.post(
    '/api/teams/:teamId/channels/:channelId/tasks/:taskId/open-pull-request',
    { bodyLimit: BODY_LIMIT },
    async (request) => {
      const { teamId, channelId, taskId } = TaskPath.parse(request.params);
      const p = principal(request);
      const { operationKey, expectedVersion, ...asked } = OpenPullRequest.parse(
        request.body,
      );
      const change = createHash('sha256')
        .update(JSON.stringify([taskId, asked]))
        .digest('hex');
      const ready = await store.tasks.opening(p, teamId, channelId, taskId, {
        operationKey,
        expectedVersion,
        change,
      });
      if (ready.replay !== null) return ready.replay;
      const token = await github.token();
      if (token === null)
        throw new DomainError('conflict', { reason: 'github-not-connected' });
      const { task, agent } = ready;
      const address = `${github.origin}/?channel=${channelId}&task=${taskId}`;
      const signed = `Kinmesh 代 ${agent.name} 为任务「${task.title}」开出：${address}`;
      const pullRequest = await openPullRequest(github.api, token, {
        ...asked,
        body: asked.body === '' ? signed : `${asked.body}\n\n---\n${signed}`,
        message: [
          asked.title,
          '',
          `Kinmesh 代 ${agent.name} 为任务「${task.title}」提交。`,
          '',
          `Kinmesh-Task: ${taskId}`,
          `Kinmesh-Change: ${change}`,
          `Co-authored-by: ${agent.name} <agent-${agent.id}@kinmesh.invalid>`,
        ].join('\n'),
        marker: `Kinmesh-Change: ${change}`,
      });
      return store.tasks.command(
        p,
        teamId,
        channelId,
        taskId,
        TaskCommand.parse({
          type: 'open-pull-request',
          operationKey,
          expectedVersion,
          change,
          pullRequest,
        }),
      );
    },
  );
}
