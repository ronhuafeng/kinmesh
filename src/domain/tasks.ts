import { z } from 'zod';
import {
  TaskId,
  HumanId,
  TeamId,
  ChannelId,
  type AgentId,
} from './contracts.js';
import { Author, Principal, CorrelationInput } from './agents.js';
import { DomainError } from './errors.js';
import { Member, TopicId, Mutation, memberKey } from './communication.js';
import { TaskAction, type TaskStatus } from './task-state.js';
import {
  PullRequestChange,
  PullRequestRef,
  TaskPullRequest,
  changeFits,
} from './pull-requests.js';
export { TaskId } from './contracts.js';
const Note = z.string().trim().min(1).max(2000);
const Working = {
  owner: Member,
  reviewer: Member.nullable(),
  note: Note.nullable(),
};
export const TaskState = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('proposed'),
      owner: z.null(),
      reviewer: Member.nullable(),
      note: z.null(),
    }),
    z.strictObject({ status: z.literal('in-progress'), ...Working }),
    z.strictObject({
      status: z.literal('review-requested'),
      ...Working,
      reviewer: Member,
    }),
    z.strictObject({
      status: z.literal('awaiting-human'),
      ...Working,
      reviewer: Member,
    }),
    z.strictObject({ status: z.literal('rework-requested'), ...Working }),
    z.strictObject({
      status: z.literal('accepted'),
      ...Working,
      reviewer: Member,
      acceptedBy: HumanId,
      acceptedAt: z.iso.datetime(),
    }),
    z.strictObject({
      status: z.literal('cancelled'),
      owner: Member.nullable(),
      reviewer: Member.nullable(),
      note: Note,
      cancelledBy: HumanId,
      cancelledAt: z.iso.datetime(),
    }),
  ])
  .refine(
    (s) =>
      s.owner === null ||
      s.reviewer === null ||
      memberKey(s.owner) !== memberKey(s.reviewer),
  );
export type TaskState = z.infer<typeof TaskState>;
/** How much a task matters next to the others: high leads its column. */
export const TaskPriority = z.enum(['high', 'normal', 'low']);
/** The day a task should be done by. */
export const TaskDue = z.iso.date().nullable();
export const TaskCreate = Mutation.extend({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000),
  criteria: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(20)
    .refine((v) => new Set(v).size === v.length),
  topicId: TopicId.nullable(),
  owner: Member.nullable(),
  reviewer: Member.nullable(),
  sourceMessageId: z.uuid().nullable(),
  sourceEventId: z.uuid().nullable(),
  /**
   * Who decides on it, when a person asks it of someone else in the channel.
   * Absent, it is whoever asked; an agent never names one.
   */
  acceptor: HumanId.nullable().default(null),
  due: TaskDue.default(null),
  priority: TaskPriority.default('normal'),
});
export type TaskCreate = z.input<typeof TaskCreate>;
export const Task = z
  .strictObject({
    id: TaskId,
    position: z.number().int().positive(),
    teamId: TeamId,
    channelId: ChannelId,
    topicId: TopicId.nullable(),
    title: TaskCreate.shape.title,
    description: TaskCreate.shape.description,
    criteria: TaskCreate.shape.criteria,
    creator: Author,
    acceptorHumanId: HumanId,
    state: TaskState,
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    // Absent from what history and receipts kept from before tasks had them.
    due: TaskDue.default(null),
    priority: TaskPriority.default('normal'),
  })
  .refine(
    (v) =>
      v.state.status !== 'accepted' || v.state.acceptedBy === v.acceptorHumanId,
  );
export type Task = z.infer<typeof Task>;
/** Who must act on a task now: the reviewer under review, the owner while it is worked on. */
export function actingMember(
  status: z.infer<typeof TaskStatus>,
  owner: Member | null,
  reviewer: Member | null,
) {
  return status === 'review-requested'
    ? reviewer
    : status === 'in-progress' || status === 'rework-requested'
      ? owner
      : null;
}
/** Completion evidence can outlive active work, but cannot survive removal of responsibility. */
export function retainsExecutionResponsibility(task: Task, agentId: AgentId) {
  const state = task.state;
  return (
    state.status !== 'cancelled' &&
    state.status !== 'proposed' &&
    ((state.owner.kind === 'agent' && state.owner.id === agentId) ||
      (state.reviewer?.kind === 'agent' && state.reviewer.id === agentId))
  );
}
const CommandBase = Mutation.extend({
  expectedVersion: z.number().int().positive(),
});
export const TaskCommand = z.discriminatedUnion('type', [
  CommandBase.extend({ type: z.literal('claim') }),
  CommandBase.extend({ type: z.literal('progress'), note: Note }),
  CommandBase.extend({
    type: z.literal('handoff'),
    recipient: Member,
    mode: z.enum(['work', 'review']),
    note: Note,
  }),
  CommandBase.extend({
    type: z.literal('request-review'),
    reviewer: Member,
    note: Note,
  }),
  CommandBase.extend({
    type: z.literal('review'),
    decision: z.enum(['approve', 'rework']),
    note: Note,
  }),
  CommandBase.extend({ type: z.literal('accept'), note: Note }),
  CommandBase.extend({ type: z.literal('rework'), note: Note }),
  CommandBase.extend({ type: z.literal('cancel'), note: Note }),
  CommandBase.extend({
    type: z.literal('link-execution'),
    reference: CorrelationInput.shape.reference,
    note: Note,
  }),
  /**
   * A pull request said to belong to the task. It is the linker's claim:
   * it changes nothing about who works, reviews or accepts.
   */
  CommandBase.extend({
    type: z.literal('link-pull-request'),
    pullRequest: PullRequestRef,
  }),
  /**
   * A pull request Kinmesh opened on GitHub for the agent working on the
   * task, from the change it handed over (`change`, its digest). Only the
   * hub makes it, once the pull request exists.
   */
  CommandBase.extend({
    type: z.literal('open-pull-request'),
    change: z.string().regex(/^[0-9a-f]{64}$/),
    pullRequest: PullRequestRef,
  }),
  /**
   * Its acceptor says what is asked again: title, description, criteria,
   * who reviews, when it is due and how much it matters, all given as they
   * should be.
   */
  CommandBase.extend({
    type: z.literal('edit'),
    title: TaskCreate.shape.title,
    description: TaskCreate.shape.description,
    criteria: TaskCreate.shape.criteria,
    reviewer: Member.nullable(),
    due: TaskDue,
    priority: TaskPriority,
  }),
]);
export type TaskCommand = z.infer<typeof TaskCommand>;
/**
 * What the agent working on a task hands over to have Kinmesh open a pull
 * request for it ([`open-pull-request`](#TaskCommand)).
 */
export const OpenPullRequest =
  CommandBase.extend(PullRequestChange).refine(changeFits);
export type OpenPullRequest = z.infer<typeof OpenPullRequest>;
export const principalMember = (p: Principal): z.infer<typeof Member> =>
  p.kind === 'human'
    ? { kind: 'human', id: p.humanId }
    : { kind: 'agent', id: p.agentId };
export const principalAuthor = (p: Principal) =>
  Author.parse(
    p.kind === 'human'
      ? { kind: 'human', humanId: p.humanId }
      : { kind: 'agent', agentId: p.agentId, grantId: p.grantId },
  );
/**
 * Whether an agent may have Kinmesh open a pull request for a task: only
 * the agent working on it, while it is worked on, at the version it read.
 * People open their own on GitHub.
 */
export function mayOpenPullRequest(
  task: Task,
  principal: Principal,
  expectedVersion: number,
) {
  const state = task.state;
  if (expectedVersion !== task.version) throw new DomainError('conflict');
  if (
    principal.kind !== 'agent' ||
    state.owner === null ||
    memberKey(state.owner) !== memberKey(principalMember(principal))
  )
    throw new DomainError('forbidden');
  if (state.status !== 'in-progress' && state.status !== 'rework-requested')
    throw new DomainError('conflict');
}
/** Pure policy/algebra. Repository additionally checks live membership, grants, targets and SQL CAS. */
export function transition(
  task: Task,
  principal: Principal,
  input: TaskCommand,
  time: string,
): TaskState {
  Principal.parse(principal);
  const current = Task.parse(task);
  const command = TaskCommand.parse(input);
  const p = principalMember(principal);
  const state = current.state;
  if (command.expectedVersion !== current.version)
    throw new DomainError('conflict');
  if (state.status === 'accepted' || state.status === 'cancelled')
    throw new DomainError('conflict');
  const owns = state.owner !== null && memberKey(state.owner) === memberKey(p);
  // Only the task's acceptor decides on it.
  const finalHuman =
    principal.kind === 'human' && principal.humanId === current.acceptorHumanId;
  const work = () => {
    if (!owns) throw new DomainError('forbidden');
  };
  const ready = () => {
    if (state.status !== 'in-progress' && state.status !== 'rework-requested')
      throw new DomainError('conflict');
  };
  switch (command.type) {
    case 'claim':
      if (state.status !== 'proposed') throw new DomainError('conflict');
      if (state.reviewer !== null && memberKey(state.reviewer) === memberKey(p))
        throw new DomainError('conflict');
      return TaskState.parse({
        status: 'in-progress',
        owner: p,
        reviewer: state.reviewer,
        note: null,
      });
    case 'progress':
      work();
      ready();
      return TaskState.parse({
        status: 'in-progress',
        owner: state.owner,
        reviewer: state.reviewer,
        note: command.note,
      });
    case 'handoff':
      if (command.mode === 'work' && finalHuman) {
        // Explicit audited recovery when the old owner cannot act, or the
        // acceptor giving work nobody has started to someone. Review
        // restarts, unless nothing was worked on yet.
        if (state.status === 'proposed') {
          if (
            state.reviewer !== null &&
            memberKey(command.recipient) === memberKey(state.reviewer)
          )
            throw new DomainError('conflict');
          return TaskState.parse({
            status: 'in-progress',
            owner: command.recipient,
            reviewer: state.reviewer,
            note: command.note,
          });
        }
      } else {
        work();
        ready();
      }
      if (
        state.owner !== null &&
        memberKey(command.recipient) === memberKey(state.owner)
      )
        throw new DomainError('conflict');
      return command.mode === 'review'
        ? TaskState.parse({
            status: 'review-requested',
            owner: state.owner,
            reviewer: command.recipient,
            note: command.note,
          })
        : TaskState.parse({
            status: 'in-progress',
            owner: command.recipient,
            reviewer: null,
            note: command.note,
          });
    case 'request-review':
      work();
      if (state.status !== 'in-progress') throw new DomainError('conflict');
      if (memberKey(command.reviewer) === memberKey(p))
        throw new DomainError('conflict');
      return TaskState.parse({
        status: 'review-requested',
        owner: state.owner,
        reviewer: command.reviewer,
        note: command.note,
      });
    case 'review':
      if (state.status !== 'review-requested')
        throw new DomainError('conflict');
      if (memberKey(state.reviewer) !== memberKey(p))
        throw new DomainError('forbidden');
      return TaskState.parse({
        status:
          command.decision === 'approve'
            ? 'awaiting-human'
            : 'rework-requested',
        owner: state.owner,
        reviewer: state.reviewer,
        note: command.note,
      });
    case 'accept':
      if (!finalHuman) throw new DomainError('forbidden');
      if (state.status !== 'awaiting-human') throw new DomainError('conflict');
      return TaskState.parse({
        ...state,
        status: 'accepted',
        note: command.note,
        acceptedBy: principal.humanId,
        acceptedAt: time,
      });
    case 'rework':
      if (!finalHuman) throw new DomainError('forbidden');
      if (state.owner === null) throw new DomainError('conflict');
      return TaskState.parse({
        status: 'rework-requested',
        owner: state.owner,
        reviewer: state.reviewer,
        note: command.note,
      });
    case 'cancel':
      if (!finalHuman) throw new DomainError('forbidden');
      return TaskState.parse({
        status: 'cancelled',
        owner: state.owner,
        reviewer: state.reviewer,
        note: command.note,
        cancelledBy: principal.humanId,
        cancelledAt: time,
      });
    case 'edit': {
      if (!finalHuman) throw new DomainError('forbidden');
      const same = (a: Member | null, b: Member | null) =>
        (a === null ? null : memberKey(a)) ===
        (b === null ? null : memberKey(b));
      // Who reviews is settled once review is asked for.
      if (
        !same(command.reviewer, state.reviewer) &&
        (state.status === 'review-requested' ||
          state.status === 'awaiting-human')
      )
        throw new DomainError('conflict');
      if (
        command.reviewer !== null &&
        state.owner !== null &&
        same(command.reviewer, state.owner)
      )
        throw new DomainError('conflict');
      // An edit changes something.
      if (
        command.title === current.title &&
        command.description === current.description &&
        JSON.stringify(command.criteria) === JSON.stringify(current.criteria) &&
        same(command.reviewer, state.reviewer) &&
        command.due === current.due &&
        command.priority === current.priority
      )
        throw new DomainError('invalid');
      return TaskState.parse({ ...state, reviewer: command.reviewer });
    }
    case 'link-pull-request':
      // Anyone who may change the task's channel's tasks, until it ends.
      return state;
    case 'open-pull-request':
      mayOpenPullRequest(current, principal, command.expectedVersion);
      return state;
    case 'link-execution':
      if (
        !owns &&
        !(
          state.status === 'review-requested' &&
          memberKey(state.reviewer) === memberKey(p)
        )
      )
        throw new DomainError('forbidden');
      return state;
  }
}
export const TaskExecution = z.strictObject({
  id: z.uuid(),
  position: z.number().int().positive(),
  taskId: TaskId,
  reference: CorrelationInput.shape.reference,
  author: Author,
  createdAt: z.iso.datetime(),
});
export const TaskResult = z.strictObject({
  task: Task,
  eventId: z.uuid(),
  executionLink: TaskExecution.nullable(),
  // Absent from receipts kept from before tasks linked pull requests.
  pullRequestLink: TaskPullRequest.nullable().default(null),
});
export const TaskEvent = z.strictObject({
  id: z.uuid(),
  position: z.number().int().positive(),
  taskId: TaskId,
  version: z.number().int().positive(),
  action: TaskAction,
  author: Author,
  createdAt: z.iso.datetime(),
  before: Task.nullable(),
  after: Task,
  command: z.union([
    TaskCreate.extend({ type: z.literal('create') }),
    TaskCommand,
  ]),
  sourceEventId: z.uuid().nullable(),
});
