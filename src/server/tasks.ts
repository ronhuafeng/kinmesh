import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TeamId, ChannelId } from '../domain/contracts.js';
import { IdentityError } from '../domain/agents.js';
import { PageInput } from '../domain/communication.js';
import { TaskId, TaskCreate, TaskCommand } from '../domain/tasks.js';
import type { Store } from '../persistence/store.js';
const ChannelPath = z.object({ teamId: TeamId, channelId: ChannelId });
const TaskPath = ChannelPath.extend({ taskId: TaskId });
function principal(request: FastifyRequest) {
  if (request.principal === null) throw new IdentityError(401);
  return request.principal;
}
export function registerTasks(app: FastifyInstance, store: Store) {
  const base = '/api/teams/:teamId/channels/:channelId/tasks';
  app.post(base, (request, reply) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return reply
      .code(201)
      .send(
        store.tasks.create(
          principal(request),
          teamId,
          channelId,
          TaskCreate.parse(request.body),
        ),
      );
  });
  app.get(base, (request) => {
    const { teamId, channelId } = ChannelPath.parse(request.params);
    return store.tasks.list(
      principal(request),
      teamId,
      channelId,
      PageInput.parse(request.query),
    );
  });
  app.get(base + '/:taskId', (request) => {
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
  ] as const) {
    app.post(base + '/:taskId/' + type, (request) => {
      const { teamId, channelId, taskId } = TaskPath.parse(request.params);
      const body = z.record(z.string(), z.unknown()).parse(request.body);
      if ('type' in body) throw new IdentityError(400);
      return store.tasks.command(
        principal(request),
        teamId,
        channelId,
        taskId,
        TaskCommand.parse({ ...body, type }),
      );
    });
  }
  app.get(base + '/:taskId/history', (request) => {
    const { teamId, channelId, taskId } = TaskPath.parse(request.params);
    return store.tasks.history(
      principal(request),
      teamId,
      channelId,
      taskId,
      PageInput.parse(request.query),
    );
  });
  app.get(base + '/:taskId/executions', (request) => {
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
