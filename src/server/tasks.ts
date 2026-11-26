import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TeamId, ChannelId } from '../domain/contracts.js';
import { DomainError } from '../domain/errors.js';
import { PageInput } from '../domain/communication.js';
import { TaskId, TaskCreate, TaskCommand } from '../domain/tasks.js';
import type { Store } from '../persistence/store.js';
import { principal } from './principals.js';
const ChannelPath = z.object({ teamId: TeamId, channelId: ChannelId });
const TaskPath = ChannelPath.extend({ taskId: TaskId });
/** `?finished=true` lists the finished tasks, the most recently finished first. */
const ListQuery = PageInput.extend({ finished: z.literal('true').optional() });
export function registerTasks(app: FastifyInstance, store: Store) {
  const base = '/api/teams/:teamId/channels/:channelId/tasks';
  app.post(base, async (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return reply
      .code(201)
      .send(
        await store.tasks.create(
          principal(request),
          teamId,
          channelId,
          TaskCreate.parse(request.body),
        ),
      );
  });
  app.get(base, async (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    const { finished, ...page } = ListQuery.parse(request.query);
    const p = principal(request);
    return finished
      ? store.tasks.finished(p, teamId, channelId, page)
      : store.tasks.list(p, teamId, channelId, page);
  });
  app.get(base + '/:taskId', async (request) => {
    const { teamId, channelId, taskId } = TaskPath.parse(request.params);
    return store.tasks.get(principal(request), teamId, channelId, taskId);
  });
  for (const type of [
    'claim',
    'progress',
    'handoff',
    'request-review',
    'review',
    'accept',
    'rework',
    'cancel',
    'link-execution',
    'edit',
    'link-pull-request',
  ] as const) {
    app.post(base + '/:taskId/' + type, async (request) => {
      const { teamId, channelId, taskId } = TaskPath.parse(request.params);
      const body = z.record(z.string(), z.unknown()).parse(request.body);
      if ('type' in body) throw new DomainError('invalid');
      return store.tasks.command(
        principal(request),
        teamId,
        channelId,
        taskId,
        TaskCommand.parse({ ...body, type }),
      );
    });
  }
  app.get(base + '/:taskId/history', async (request) => {
    const { teamId, channelId, taskId } = TaskPath.parse(request.params);
    return store.tasks.history(
      principal(request),
      teamId,
      channelId,
      taskId,
      PageInput.parse(request.query),
    );
  });
  app.get(base + '/:taskId/pull-requests', async (request) => {
    const { teamId, channelId, taskId } = TaskPath.parse(request.params);
    return store.tasks.pullRequests(
      principal(request),
      teamId,
      channelId,
      taskId,
    );
  });
  app.get(base + '/:taskId/executions', async (request) => {
    const { teamId, channelId, taskId } = TaskPath.parse(request.params);
    return store.tasks.executions(
      principal(request),
      teamId,
      channelId,
      taskId,
      PageInput.parse(request.query),
    );
  });
}
