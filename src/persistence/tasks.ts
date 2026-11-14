import type { Database } from './database.js';
import { enqueueFact } from './inbox-enqueue.js';
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  max,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { communicationRepository } from './communication.js';
import { transactional, snapshotPage, referenceKey } from './transactional.js';
import type { TeamId, TaskId } from '../domain/contracts.js';
import { HumanId, type ChannelId } from '../domain/contracts.js';
import {
  Author,
  IdentityError,
  type Principal,
  type Scope,
} from '../domain/agents.js';
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
  d: Database,
  agents: ReturnType<typeof agentRepository>,
  communication: ReturnType<typeof communicationRepository>,
) {
  const { q, atomic, receipt } = transactional(d);
  async function access(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    scope: Scope = 'tasks:read',
  ) {
    await communication.channel(p, teamId, channelId);
    await agents.teamAccess(p, teamId, 'tasks:read', scope);
  }
  async function row(teamId: TeamId, channelId: ChannelId, id: TaskId) {
    const value = (
      await q()
        .select()
        .from(s.tasks)
        .where(
          and(
            eq(s.tasks.id, id),
            eq(s.tasks.teamId, teamId),
            eq(s.tasks.channelId, channelId),
          ),
        )
        .limit(1)
    )[0];
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
  async function target(
    p: Principal,
    teamId: TeamId,
    channelId: ChannelId,
    member: Member | null,
  ) {
    if (member !== null)
      await communication.validateParticipant(p, teamId, channelId, member);
  }
  async function insertExecution(
    p: Principal,
    taskId: TaskId,
    reference: z.infer<typeof TaskExecution>['reference'],
    time: string,
  ) {
    const inserted = (
      await q()
        .insert(s.taskExecutions)
        .values({
          id: randomUUID(),
          taskId,
          referenceKey: referenceKey(reference),
          reference: JSON.stringify(reference),
          author: JSON.stringify(principalAuthor(p)),
          createdAt: time,
        })
        .returning()
    )[0];
    if (inserted === undefined) throw new Error('Execution link not recorded');
    return TaskExecution.parse({
      id: inserted.id,
      position: inserted.position,
      taskId: inserted.taskId,
      createdAt: inserted.createdAt,
      reference: decode(inserted.reference),
      author: decode(inserted.author),
    });
  }
  async function record(
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
    await q()
      .insert(s.communicationOutbox)
      .values({ id, channelId: task.channelId, fact: JSON.stringify(fact) });
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
    const inserted = (
      await q()
        .insert(s.taskEvents)
        .values({
          id,
          taskId: task.id,
          version: task.version,
          event: JSON.stringify(event),
        })
        .returning({ position: s.taskEvents.position })
    )[0];
    if (inserted === undefined) throw new Error('Task event not recorded');
    TaskEvent.parse({ ...event, position: inserted.position });
    await enqueueFact(q(), fact);
    return TaskResult.parse({ task, eventId: id, executionLink });
  }
  /** Whether a person is joined to the channel now. */
  async function joinedPerson(channelId: ChannelId, humanId: string) {
    return (
      (
        await q()
          .select({ id: s.channelParticipants.humanId })
          .from(s.channelParticipants)
          .where(
            and(
              eq(s.channelParticipants.channelId, channelId),
              eq(s.channelParticipants.memberKey, `human:${humanId}`),
              eq(s.channelParticipants.state, 'joined'),
            ),
          )
          .limit(1)
      )[0] !== undefined
    );
  }
  /** The person who wrote a fact or a message (stored JSON), if a person did. */
  function personOf(stored: string | undefined) {
    if (stored === undefined) return undefined;
    const value = decode(stored);
    const parsed = Author.safeParse(
      typeof value === 'object' && value !== null && 'author' in value
        ? value.author
        : value,
    );
    return parsed.success && parsed.data.kind === 'human'
      ? parsed.data.humanId
      : undefined;
  }
  /**
   * Who decides on a new task: the person who asked for it. A person asks
   * for their own, or names someone in the channel. An agent's task belongs
   * to the person at the root of what the agent was answering; failing
   * that, the author of the message it came from, then the person who last
   * spoke in the channel, then anyone in it.
   */
  async function acceptorFor(
    p: Principal,
    channelId: ChannelId,
    data: z.output<typeof TaskCreate>,
  ) {
    if (p.kind === 'human') {
      if (data.acceptor === null) return p.humanId;
      if (!(await joinedPerson(channelId, data.acceptor)))
        throw new IdentityError(404);
      return data.acceptor;
    }
    if (data.acceptor !== null) throw new IdentityError(403);
    const rootAuthor = personOf(
      data.sourceEventId === null
        ? undefined
        : (
            await q()
              .select({ fact: s.communicationOutbox.fact })
              .from(s.inboxCauses)
              .innerJoin(
                s.communicationOutbox,
                eq(s.communicationOutbox.id, s.inboxCauses.rootId),
              )
              .where(eq(s.inboxCauses.eventId, data.sourceEventId))
              .limit(1)
          )[0]?.fact,
    );
    const messageAuthor =
      data.sourceMessageId === null
        ? undefined
        : personOf(
            (
              await q()
                .select({ author: s.messages.author })
                .from(s.messages)
                .where(eq(s.messages.id, data.sourceMessageId))
                .limit(1)
            )[0]?.author,
          );
    const lastSpoke = personOf(
      (
        await q()
          .select({ author: s.messages.author })
          .from(s.messages)
          .innerJoin(
            s.channelParticipants,
            and(
              eq(s.channelParticipants.channelId, s.messages.channelId),
              eq(
                s.channelParticipants.memberKey,
                sql`'human:' || (${s.messages.author}::jsonb ->> 'humanId')`,
              ),
              eq(s.channelParticipants.state, 'joined'),
            ),
          )
          .where(
            and(
              eq(s.messages.channelId, channelId),
              sql`(${s.messages.author}::jsonb ->> 'kind') = 'human'`,
            ),
          )
          .orderBy(desc(s.messages.createdAt))
          .limit(1)
      )[0]?.author,
    );
    const anyone = (
      await q()
        .select({ id: s.channelParticipants.humanId })
        .from(s.channelParticipants)
        .where(
          and(
            eq(s.channelParticipants.channelId, channelId),
            eq(s.channelParticipants.state, 'joined'),
            isNotNull(s.channelParticipants.humanId),
          ),
        )
        .orderBy(asc(s.channelParticipants.humanId))
        .limit(1)
    )[0]?.id;
    let chosen: string | undefined;
    for (const id of [rootAuthor, messageAuthor, lastSpoke])
      if (id !== undefined && (await joinedPerson(channelId, id))) {
        chosen = id;
        break;
      }
    const acceptor = chosen ?? anyone;
    // Nobody in the channel can decide on it.
    if (!acceptor) throw new IdentityError(409);
    return HumanId.parse(acceptor);
  }
  return {
    create(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: TaskCreate,
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId, 'tasks:write');
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
          async () => {
            // An agent may only propose work for itself; a person may assign.
            if (
              p.kind !== 'human' &&
              ((data.owner !== null &&
                memberKey(data.owner) !== memberKey(principalMember(p))) ||
                data.reviewer !== null)
            )
              throw new IdentityError(403);
            await target(p, teamId, channelId, data.owner);
            await target(p, teamId, channelId, data.reviewer);
            if (data.topicId !== null)
              await communication.topic(p, teamId, channelId, data.topicId);
            await communication.validateCause(
              p,
              teamId,
              channelId,
              data.sourceMessageId,
              data.sourceEventId,
            );
            const acceptorHumanId = await acceptorFor(p, channelId, data);
            const time = new Date().toISOString();
            const state = TaskState.parse({
              status: data.owner === null ? 'proposed' : 'in-progress',
              owner: data.owner,
              reviewer: data.reviewer,
              note: null,
            });
            const inserted = (
              await q()
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
                  ownerKey:
                    state.owner === null ? null : memberKey(state.owner),
                  version: 1,
                  createdAt: time,
                  updatedAt: time,
                })
                .returning()
            )[0];
            if (inserted === undefined) throw new Error('Task not recorded');
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
      return atomic(async () => {
        await access(p, teamId, channelId);
        return view(await row(teamId, channelId, id));
      });
    },
    /**
     * Tasks across every channel a human has joined that wait on that human's
     * decision: sign-off, review or rework. Newest change first.
     */
    waitingOn(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        if (p.kind !== 'human') throw new IdentityError(403);
        await agents.teamAccess(p, teamId, 'tasks:read');
        const me = memberKey(principalMember(p));
        return (
          await q()
            .select({ task: s.tasks, channelName: s.channels.name })
            .from(s.tasks)
            .innerJoin(s.channels, eq(s.channels.id, s.tasks.channelId))
            .innerJoin(
              s.channelParticipants,
              and(
                eq(s.channelParticipants.channelId, s.tasks.channelId),
                eq(s.channelParticipants.memberKey, me),
                eq(s.channelParticipants.state, 'joined'),
              ),
            )
            .where(
              and(
                eq(s.tasks.teamId, teamId),
                or(
                  and(
                    eq(s.tasks.status, 'awaiting-human'),
                    eq(s.tasks.acceptorHumanId, p.humanId),
                  ),
                  and(
                    eq(s.tasks.status, 'review-requested'),
                    sql`(${s.tasks.state}::jsonb -> 'reviewer' ->> 'kind') = 'human'`,
                    sql`(${s.tasks.state}::jsonb -> 'reviewer' ->> 'id') = ${p.humanId}`,
                  ),
                  and(
                    eq(s.tasks.status, 'rework-requested'),
                    eq(s.tasks.ownerKey, me),
                  ),
                ),
              ),
            )
            .orderBy(sql`${s.tasks.updatedAt} DESC`)
            .limit(50)
        ).map((r) => ({ task: view(r.task), channelName: r.channelName }));
      });
    },
    list(
      p: Principal,
      teamId: TeamId,
      channelId: ChannelId,
      input: PageInput = {},
    ) {
      return atomic(async () => {
        await access(p, teamId, channelId);
        return snapshotPage(
          input,
          ['tasks', teamId, channelId, memberKey(principalMember(p))],
          Task,
          async () =>
            (
              await q()
                .select({ value: max(s.tasks.position) })
                .from(s.tasks)
                .where(eq(s.tasks.channelId, channelId))
                .limit(1)
            )[0]?.value ?? 0,
          async (after, maximum, limit) =>
            (
              await q()
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
            ).map(view),
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
      return atomic(async () => {
        await access(p, teamId, channelId, 'tasks:write');
        const current = view(await row(teamId, channelId, id));
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
      return atomic(async () => {
        const data = TaskCommand.parse(input);
        await access(
          p,
          teamId,
          channelId,
          data.type === 'review' ? 'tasks:review' : 'tasks:write',
        );
        const old = await row(teamId, channelId, id);
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
          async () => {
            const current = view(old);
            const time = new Date().toISOString();
            const state = transition(current, p, data, time);
            if (data.type === 'handoff')
              await target(p, teamId, channelId, data.recipient);
            if (data.type === 'request-review')
              await target(p, teamId, channelId, data.reviewer);
            // Assigned people must still be active/joined before taking review or acceptance decisions.
            if (data.type === 'review' || data.type === 'accept') {
              await target(p, teamId, channelId, state.owner);
              await target(p, teamId, channelId, state.reviewer);
            }
            const changed = await q()
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
              );
            if (changed.count !== 1) throw new IdentityError(409);
            let executionLink: z.infer<typeof TaskExecution> | null = null;
            if (data.type === 'link-execution')
              executionLink = await insertExecution(
                p,
                id,
                data.reference,
                time,
              );
            const previous = (
              await q()
                .select()
                .from(s.taskEvents)
                .where(
                  and(
                    eq(s.taskEvents.taskId, id),
                    eq(s.taskEvents.version, old.version),
                  ),
                )
                .limit(1)
            )[0];
            if (previous === undefined)
              throw new Error('Missing task audit predecessor');
            return record(
              p,
              view(await row(teamId, channelId, id)),
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
      return atomic(async () => {
        await access(p, teamId, channelId);
        await row(teamId, channelId, id);
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
          async () =>
            (
              await q()
                .select({ value: max(s.taskEvents.position) })
                .from(s.taskEvents)
                .where(eq(s.taskEvents.taskId, id))
                .limit(1)
            )[0]?.value ?? 0,
          async (after, maximum, limit) =>
            (
              await q()
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
            ).map((r) =>
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
      return atomic(async () => {
        await access(p, teamId, channelId);
        await row(teamId, channelId, id);
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
          async () =>
            (
              await q()
                .select({ value: max(s.taskExecutions.position) })
                .from(s.taskExecutions)
                .where(eq(s.taskExecutions.taskId, id))
                .limit(1)
            )[0]?.value ?? 0,
          async (after, maximum, limit) =>
            (
              await q()
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
            ).map((r) =>
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
