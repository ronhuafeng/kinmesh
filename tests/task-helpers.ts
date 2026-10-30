import type { Principal } from '../src/domain/agents.js';
import { TaskCreate, TaskCommand, type Task } from '../src/domain/tasks.js';
import { communicationFixture, key } from './communication-helpers.js';
import { profileInput } from './agent-helpers.js';
export const taskInput = (overrides: Partial<TaskCreate> = {}) =>
  TaskCreate.parse({
    operationKey: key(),
    title: 'Implement bounded change',
    description: 'Local task test',
    criteria: ['Reviewed evidence', 'Human acceptance'],
    topicId: null,
    owner: null,
    reviewer: null,
    sourceMessageId: null,
    sourceEventId: null,
    ...overrides,
  });
export type CommandData = {
  [K in TaskCommand['type']]: Omit<
    Extract<TaskCommand, { type: K }>,
    'operationKey' | 'expectedVersion'
  >;
}[TaskCommand['type']];
export const commandInput = (task: Task, input: CommandData) =>
  TaskCommand.parse({
    operationKey: key(),
    expectedVersion: task.version,
    ...input,
  });
export async function taskFixture() {
  const f = await communicationFixture();
  f.invite();
  const developerGrant = f.store.agents.issue(
    f.principal,
    f.teamId,
    f.agent.id,
    {
      label: 'Task developer test',
      scopes: ['channels:read', 'tasks:read', 'tasks:write'],
      lifetimeSeconds: 3600,
    },
  );
  const developer = f.store.agents.resolveToken(developerGrant.token);
  const reviewer = f.store.agents.create(f.principal, f.teamId, {
    ...profileInput,
    name: 'Reviewer',
    role: 'reviewer',
  });
  f.comm.enroll(
    f.principal,
    f.teamId,
    f.channelId,
    { operationKey: key(), member: { kind: 'agent', id: reviewer.id } },
    'invite',
  );
  const reviewerGrant = f.store.agents.issue(
    f.principal,
    f.teamId,
    reviewer.id,
    {
      label: 'Task reviewer test',
      scopes: ['channels:read', 'tasks:read', 'tasks:write', 'tasks:review'],
      lifetimeSeconds: 3600,
    },
  );
  const reviewPrincipal = f.store.agents.resolveToken(reviewerGrant.token);
  const tasks = f.store.tasks;
  const taskPath = f.channelPath + '/tasks';
  const create = (input: Partial<TaskCreate> = {}) =>
    tasks.create(f.principal, f.teamId, f.channelId, taskInput(input));
  const act = (p: Principal, task: Task, input: CommandData) =>
    tasks.command(p, f.teamId, f.channelId, task.id, commandInput(task, input));
  return {
    ...f,
    tasks,
    taskPath,
    developer,
    reviewer,
    reviewPrincipal,
    developerGrant,
    reviewerGrant,
    developerHeaders: { authorization: 'Bearer ' + developerGrant.token },
    reviewerHeaders: { authorization: 'Bearer ' + reviewerGrant.token },
    create,
    act,
  };
}
