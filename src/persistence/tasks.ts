import { enqueueFact } from './inbox-enqueue.js';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, lte, max } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { communicationRepository } from './communication.js';
import { transactional, snapshotPage, fingerprint } from './transactional.js';
import type { TeamId, TaskId } from '../domain/contracts.js';
import { HumanId, type ChannelId } from '../domain/contracts.js';
import { IdentityError, type Principal, type Scope } from '../domain/agents.js';
import {
  memberKey,
  type Member,
  type PageInput,
  TaskFact,
} from '../domain/communication.js';
import {
  Task,
  TaskCreate,
  TaskCommand,
  TaskEvent,
  TaskExecution,
  TaskResult,
  TaskState,
  transition,
  principalMember,
  principalAuthor,
  retainsExecutionResponsibility,
} from '../domain/tasks.js';
type ChannelId = z.infer<typeof ChannelId>;
const decode = (value: string): unknown => JSON.parse(value);
export function taskRepository(
  db: BetterSQLite3Database<typeof s>,
  agents: ReturnType<typeof agentRepository>,
  communication: ReturnType<typeof communicationRepository>,
) {
  const { atomic, receipt } = transactional(db);
  function access(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    scope: Scope = 'tasks:read',
  ) {
    communication.channel(p, teamId, channelId);
    agents.teamAccess(p, teamId, 'tasks:read');
    return agents.teamAccess(p, teamId, scope).role;
  }
  function row(teamId: TeamId, channelId: ChannelId, id: TaskId) {
    const value = db
      .select()
      .from(s.tasks)
      .where(
        and(
          eq(s.tasks.id, id),
          eq(s.tasks.teamId, teamId),
          eq(s.tasks.channelId, channelId),
        ),
      )
      .get();
    if (value === undefined) throw new IdentityError(404);
    return value;
  }
  function view(value: typeof s.tasks.$inferSelect): Task {
    return Task.parse({
      id: value.id,
      position: value.position,
      teamId: value.teamId,
      channelId: value.channelId,
      topicId: value.topicId,
      title: value.title,
      description: value.description,
      acceptorHumanId: value.acceptorHumanId,
      version: value.version,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      criteria: decode(value.criteria),
      creator: decode(value.creator),
      state: decode(value.state),
    });
  }
  function target(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    member: Member | null,
  ) {
    if (member !== null)
      communication.validateParticipant(p, teamId, channelId, member);
  }
  function insertExecution(
    p: Principal,
    taskId: TaskId,
    reference: z.infer<typeof TaskExecution>['reference'],
    time: string,
  ) {
    const inserted = db
      .insert(s.taskExecutions)
      .values({
        id: randomUUID(),
        taskId,
        referenceKey: fingerprint([
          reference.backend,
          reference.environmentId,
          reference.threadId,
          reference.runId ?? null,
        ]),
        reference: JSON.stringify(reference),
        author: JSON.stringify(principalAuthor(p)),
        createdAt: time,
      })
      .returning()
      .get();
    return TaskExecution.parse({
      id: inserted.id,
      position: inserted.position,
      taskId: inserted.taskId,
      createdAt: inserted.createdAt,
      reference: decode(inserted.reference),
      author: decode(inserted.author),
    });
  }
  function record(
    p: Principal,
    task: Task,
    before: Task | null,
    command: z.infer<typeof TaskEvent>['command'],
    executionLink: z.infer<typeof TaskExecution> | null,
    sourceEventId: string | null,
    sourceMessageId: string | null,
  ) {
    const id = randomUUID();
    const author = principalAuthor(p);
    const createdAt = task.updatedAt;
    const recipients = [task.state.owner, task.state.reviewer].filter(
      (m): m is Member => m !== null,
    );
    const fact = TaskFact.parse({
      version: 1,
      id,
      teamId: task.teamId,
      channelId: task.channelId,
      topicId: task.topicId,
      createdAt,
      author,
      kind: 'task.changed',
      messageId: null,
      mentions: recipients,
      participant: null,
      participantState: null,
      sourceMessageId,
      sourceEventId,
      operationKey: command.operationKey,
      taskId: task.id,
      taskVersion: task.version,
      taskStatus: task.state.status,
      taskAction: command.type,
      owner: task.state.owner,
      reviewer: task.state.reviewer,
      executionLinkId: executionLink?.id ?? null,
    });
    db.insert(s.communicationOutbox)
      .values({ id, channelId: task.channelId, fact: JSON.stringify(fact) })
      .run();
    const event = {
      id,
      taskId: task.id,
      version: task.version,
      action: command.type,
      author,
      createdAt,
      before,
      after: task,
      command,
      sourceEventId,
    };
    const inserted = db
      .insert(s.taskEvents)
      .values({
        id,
        taskId: task.id,
        version: task.version,
        event: JSON.stringify(event),
      })
      .returning({ position: s.taskEvents.position })
      .get();
    TaskEvent.parse({ ...event, position: inserted.position });
    enqueueFact(db, fact);
    return TaskResult.parse({ task, eventId: id, executionLink });
  }
  return {
    create(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: TaskCreate,
    ) {
      return atomic(() => {
        const role = access(p, teamId, channelId, 'tasks:write');
        const data = TaskCreate.parse(input);
        return receipt(
          JSON.stringify([
            teamId,
            memberKey(principalMember(p)),
            channelId,
            'task.create',
          ]),
          data.operationKey,
          data,
          TaskResult,
          () => {
            if (
              role !== 'owner' &&
              ((data.owner !== null &&
                memberKey(data.owner) !== memberKey(principalMember(p))) ||
                data.reviewer !== null)
            )
              throw new IdentityError(403);
            target(p, teamId, channelId, data.owner);
            target(p, teamId, channelId, data.reviewer);
            if (data.topicId !== null)
              communication.topic(p, teamId, channelId, data.topicId);
            communication.validateCause(
              p,
              teamId,
              channelId,
              data.sourceMessageId,
              data.sourceEventId,
            );
            const candidate =
              p.kind === 'human' && role === 'owner'
                ? p.humanId
                : db
                    .select({ id: s.memberships.humanId })
                    .from(s.memberships)
                    .innerJoin(
                      s.channelParticipants,
                      and(
                        eq(
                          s.channelParticipants.humanId,
                          s.memberships.humanId,
                        ),
                        eq(s.channelParticipants.teamId, s.memberships.teamId),
                      ),
                    )
                    .where(
                      and(
                        eq(s.memberships.teamId, teamId),
                        eq(s.memberships.role, 'owner'),
                        eq(s.channelParticipants.channelId, channelId),
                        eq(s.channelParticipants.state, 'joined'),
                      ),
                    )
                    .orderBy(asc(s.memberships.humanId))
                    .get()?.id;
            if (candidate === undefined) throw new IdentityError(409);
            const acceptorHumanId = HumanId.parse(candidate);
            const time = new Date().toISOString();
            const state = TaskState.parse({
              status: data.owner === null ? 'proposed' : 'in-progress',
              owner: data.owner,
              reviewer: data.reviewer,
              note: null,
            });
            const inserted = db
              .insert(s.tasks)
              .values({
                id: randomUUID(),
                teamId,
                channelId,
                topicId: data.topicId,
                title: data.title,
                description: data.description,
                criteria: JSON.stringify(data.criteria),
                creator: JSON.stringify(principalAuthor(p)),
                acceptorHumanId,
                state: JSON.stringify(state),
                status: state.status,
                ownerKey: state.owner === null ? null : memberKey(state.owner),
                version: 1,
                createdAt: time,
                updatedAt: time,
              })
              .returning()
              .get();
            return record(
              p,
              view(inserted),
              null,
              { ...data, type: 'create' },
              null,
              data.sourceEventId,
              data.sourceMessageId,
            );
          },
        );
      });
    },
    get(p: Principal, teamId: TeamId, channelId: ChannelId, id: TaskId) {
      return atomic(() => {
        access(p, teamId, channelId);
        return view(row(teamId, channelId, id));
      });
    },
    list(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
    ) {
      return atomic(() => {
        access(p, teamId, channelId);
        return snapshotPage(
          input,
          ['tasks', teamId, channelId, memberKey(principalMember(p))],
          Task,
          () =>
            db
              .select({ value: max(s.tasks.position) })
              .from(s.tasks)
              .where(eq(s.tasks.channelId, channelId))
              .get()?.value ?? 0,
          (after, maximum, limit) =>
            db
              .select()
              .from(s.tasks)
              .where(
                and(
                  eq(s.tasks.channelId, channelId),
                  gt(s.tasks.position, after),
                  lte(s.tasks.position, maximum),
                ),
              )
              .orderBy(asc(s.tasks.position))
              .limit(limit)
              .all()
              .map(view),
        );
      });
    },
    /** Trusted Inbox ACK only; the enclosing transaction binds the exact native result and source. */
    recordInboxExecution(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      id: TaskId,
      reference: z.infer<typeof TaskExecution>['reference'],
    ) {
      return atomic(() => {
        access(p, teamId, channelId, 'tasks:write');
        const current = view(row(teamId, channelId, id));
        if (
          p.kind !== 'agent' ||
          !retainsExecutionResponsibility(current, p.agentId)
        )
          throw new IdentityError(403);
        // Recording execution evidence does not create a workflow decision or change its version.
        return insertExecution(
          p,
          id,
          TaskExecution.shape.reference.parse(reference),
          new Date().toISOString(),
        );
      });
    },
    command(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      id: TaskId,
      input: TaskCommand,
    ) {
      return atomic(() => {
        const data = TaskCommand.parse(input);
        const role = access(
          p,
          teamId,
          channelId,
          data.type === 'review' ? 'tasks:review' : 'tasks:write',
        );
        const old = row(teamId, channelId, id);
        return receipt(
          JSON.stringify([
            teamId,
            memberKey(principalMember(p)),
            id,
            'task.' + data.type,
          ]),
          data.operationKey,
          data,
          TaskResult,
          () => {
            const current = view(old);
            const time = new Date().toISOString();
            const state = transition(current, p, data, role === 'owner', time);
            if (data.type === 'handoff')
              target(p, teamId, channelId, data.recipient);
            if (data.type === 'request-review')
              target(p, teamId, channelId, data.reviewer);
            // Assigned people must still be active/joined before taking review or acceptance decisions.
            if (data.type === 'review' || data.type === 'accept') {
              target(p, teamId, channelId, state.owner);
              target(p, teamId, channelId, state.reviewer);
            }
            const changed = db
              .update(s.tasks)
              .set({
                state: JSON.stringify(state),
                status: state.status,
                ownerKey: state.owner === null ? null : memberKey(state.owner),
                version: old.version + 1,
                updatedAt: time,
              })
              .where(
                and(
                  eq(s.tasks.id, id),
                  eq(s.tasks.version, data.expectedVersion),
                  eq(s.tasks.status, old.status),
                  old.ownerKey === null
                    ? isNull(s.tasks.ownerKey)
                    : eq(s.tasks.ownerKey, old.ownerKey),
                  data.type === 'claim'
                    ? and(
                        eq(s.tasks.status, 'proposed'),
                        isNull(s.tasks.ownerKey),
                      )
                    : undefined,
                ),
              )
              .run();
            if (changed.changes !== 1) throw new IdentityError(409);
            let executionLink: z.infer<typeof TaskExecution> | null = null;
            if (data.type === 'link-execution')
              executionLink = insertExecution(p, id, data.reference, time);
            const previous = db
              .select()
              .from(s.taskEvents)
              .where(
                and(
                  eq(s.taskEvents.taskId, id),
                  eq(s.taskEvents.version, old.version),
                ),
              )
              .get();
            if (previous === undefined)
              throw new Error('Missing task audit predecessor');
            return record(
              p,
              view(row(teamId, channelId, id)),
              current,
              data,
              executionLink,
              previous.id,
              null,
            );
          },
        );
      });
    },
    history(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      id: TaskId,
      input: PageInput = {},
    ) {
      return atomic(() => {
        access(p, teamId, channelId);
        row(teamId, channelId, id);
        return snapshotPage(
          input,
          [
            'task-history',
            teamId,
            channelId,
            id,
            memberKey(principalMember(p)),
          ],
          TaskEvent,
          () =>
            db
              .select({ value: max(s.taskEvents.position) })
              .from(s.taskEvents)
              .where(eq(s.taskEvents.taskId, id))
              .get()?.value ?? 0,
          (after, maximum, limit) =>
            db
              .select()
              .from(s.taskEvents)
              .where(
                and(
                  eq(s.taskEvents.taskId, id),
                  gt(s.taskEvents.position, after),
                  lte(s.taskEvents.position, maximum),
                ),
              )
              .orderBy(asc(s.taskEvents.position))
              .limit(limit)
              .all()
              .map((r) =>
                TaskEvent.parse({
                  ...decodeEvent(r.event),
                  position: r.position,
                }),
              ),
        );
      });
    },
    executions(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      id: TaskId,
      input: PageInput = {},
    ) {
      return atomic(() => {
        access(p, teamId, channelId);
        row(teamId, channelId, id);
        return snapshotPage(
          input,
          [
            'task-executions',
            teamId,
            channelId,
            id,
            memberKey(principalMember(p)),
          ],
          TaskExecution,
          () =>
            db
              .select({ value: max(s.taskExecutions.position) })
              .from(s.taskExecutions)
              .where(eq(s.taskExecutions.taskId, id))
              .get()?.value ?? 0,
          (after, maximum, limit) =>
            db
              .select()
              .from(s.taskExecutions)
              .where(
                and(
                  eq(s.taskExecutions.taskId, id),
                  gt(s.taskExecutions.position, after),
                  lte(s.taskExecutions.position, maximum),
                ),
              )
              .orderBy(asc(s.taskExecutions.position))
              .limit(limit)
              .all()
              .map((r) =>
                TaskExecution.parse({
                  id: r.id,
                  position: r.position,
                  taskId: r.taskId,
                  createdAt: r.createdAt,
                  reference: decode(r.reference),
                  author: decode(r.author),
                }),
              ),
        );
      });
    },
  };
}
function decodeEvent(value: string) {
  return z.record(z.string(), z.unknown()).parse(decode(value));
}
