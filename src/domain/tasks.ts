import { z } from 'zod';
import { TaskId, HumanId, TeamId, ChannelId } from './contracts.js';
import {
  Author,
  IdentityError,
  Principal,
  CorrelationInput,
} from './agents.js';
import { Member, TopicId, Mutation, memberKey } from './communication.js';
import { TaskAction } from './task-state.js';
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
});
export type TaskCreate = z.infer<typeof TaskCreate>;
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
  })
  .refine(
    (v) =>
      v.state.status !== 'accepted' || v.state.acceptedBy === v.acceptorHumanId,
  );
export type Task = z.infer<typeof Task>;
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
]);
export type TaskCommand = z.infer<typeof TaskCommand>;
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
/** Pure policy/algebra. Repository additionally checks live membership, grants, targets and SQL CAS. */
export function transition(
  task: Task,
  principal: Principal,
  input: TaskCommand,
  isHumanOwner: boolean,
  time: string,
): TaskState {
  Principal.parse(principal);
  const current = Task.parse(task);
  const command = TaskCommand.parse(input);
  const p = principalMember(principal);
  const state = current.state;
  if (command.expectedVersion !== current.version) throw new IdentityError(409);
  if (state.status === 'accepted' || state.status === 'cancelled')
    throw new IdentityError(409);
  const owns = state.owner !== null && memberKey(state.owner) === memberKey(p);
  const finalHuman =
    principal.kind === 'human' &&
    isHumanOwner &&
    principal.humanId === current.acceptorHumanId;
  const work = () => {
    if (!owns) throw new IdentityError(403);
  };
  const ready = () => {
    if (state.status !== 'in-progress' && state.status !== 'rework-requested')
      throw new IdentityError(409);
  };
  switch (command.type) {
    case 'claim':
      if (state.status !== 'proposed') throw new IdentityError(409);
      if (state.reviewer !== null && memberKey(state.reviewer) === memberKey(p))
        throw new IdentityError(409);
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
        // Explicit audited recovery when the old owner cannot act. Review restarts.
        if (state.owner === null) throw new IdentityError(409);
      } else {
        work();
        ready();
      }
      if (
        state.owner !== null &&
        memberKey(command.recipient) === memberKey(state.owner)
      )
        throw new IdentityError(409);
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
      if (state.status !== 'in-progress') throw new IdentityError(409);
      if (memberKey(command.reviewer) === memberKey(p))
        throw new IdentityError(409);
      return TaskState.parse({
        status: 'review-requested',
        owner: state.owner,
        reviewer: command.reviewer,
        note: command.note,
      });
    case 'review':
      if (state.status !== 'review-requested') throw new IdentityError(409);
      if (memberKey(state.reviewer) !== memberKey(p))
        throw new IdentityError(403);
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
      if (!finalHuman) throw new IdentityError(403);
      if (state.status !== 'awaiting-human') throw new IdentityError(409);
      return TaskState.parse({
        ...state,
        status: 'accepted',
        note: command.note,
        acceptedBy: principal.humanId,
        acceptedAt: time,
      });
    case 'rework':
      if (!finalHuman) throw new IdentityError(403);
      if (state.owner === null) throw new IdentityError(409);
      return TaskState.parse({
        status: 'rework-requested',
        owner: state.owner,
        reviewer: state.reviewer,
        note: command.note,
      });
    case 'cancel':
      if (!finalHuman) throw new IdentityError(403);
      return TaskState.parse({
        status: 'cancelled',
        owner: state.owner,
        reviewer: state.reviewer,
        note: command.note,
        cancelledBy: principal.humanId,
        cancelledAt: time,
      });
    case 'link-execution':
      if (
        !owns &&
        !(
          state.status === 'review-requested' &&
          memberKey(state.reviewer) === memberKey(p)
        )
      )
        throw new IdentityError(403);
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
