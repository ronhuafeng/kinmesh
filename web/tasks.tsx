import { authorName } from './names.js';
import { useContext, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import {
  TaskCommand,
  TaskCreate,
  TaskEvent,
  TaskExecution,
} from '../src/domain/tasks.js';
import type { Task } from '../src/domain/tasks.js';
import { Member, memberKey, pageOf } from '../src/domain/communication.js';
import type { Message } from '../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, Offline, value } from './api.js';
import { ActionForm, Field, Notice, SubmitGroup } from './forms.js';
import { age, Avatar, Drawer, shortTime, StatusChip, statuses } from './ui.js';
import type { Status } from './ui.js';

export function memberFrom(value: string): Member | null {
  if (!value) return null;
  const [kind, id] = value.split(':');
  return Member.parse({ kind, id });
}
export function memberName(
  member: Member | null,
  data: WorkspaceSnapshot,
): string {
  if (!member) return 'Unassigned';
  return member.kind === 'human'
    ? member.id === data.human.id
      ? `${data.human.username} (human)`
      : 'Human member'
    : (data.agents.find((a) => a.id === member.id)?.name ?? 'Agent member');
}
/** What the signed-in human must decide or do next, if anything. */
export function humanAsk(task: Task, data: WorkspaceSnapshot): string | null {
  const me = memberKey({ kind: 'human', id: data.human.id });
  const { status, owner, reviewer } = task.state;
  if (status === 'awaiting-human' && task.acceptorHumanId === data.human.id)
    return 'Your sign-off';
  if (status === 'review-requested' && memberKey(reviewer) === me)
    return 'Your review';
  if (status === 'rework-requested' && memberKey(owner) === me)
    return 'Your rework';
  return null;
}
const stages = [
  { label: 'Proposed', statuses: ['proposed'] },
  { label: 'Working', statuses: ['in-progress', 'rework-requested'] },
  { label: 'Review', statuses: ['review-requested'] },
  { label: 'Human sign-off', statuses: ['awaiting-human'] },
  { label: 'Done', statuses: ['accepted'] },
];
function Lifecycle({
  status,
  compact = false,
}: {
  status: Status;
  compact?: boolean;
}) {
  const current = stages.findIndex((s) => s.statuses.includes(status));
  if (current < 0) return null;
  return (
    <ol
      className={'lifecycle' + (compact ? ' compact' : '')}
      aria-label={compact ? undefined : 'Task progress'}
      aria-hidden={compact ? 'true' : undefined}
    >
      {stages.map((stage, index) => (
        <li
          key={stage.label}
          data-step={
            index < current || status === 'accepted'
              ? 'done'
              : index === current
                ? 'current'
                : 'todo'
          }
          aria-current={index === current ? 'step' : undefined}
        >
          <span>{stage.label}</span>
        </li>
      ))}
    </ol>
  );
}
export function MemberSelect({
  name,
  id,
  data,
  required = false,
  empty = 'Unassigned',
  defaultValue = '',
  exclude = null,
}: {
  name: string;
  id?: string;
  data: WorkspaceSnapshot;
  required?: boolean;
  empty?: string;
  defaultValue?: string;
  exclude?: Member | null;
}) {
  const shown = (member: Member) =>
    exclude === null || memberKey(member) !== memberKey(exclude);
  return (
    <select id={id} name={name} required={required} defaultValue={defaultValue}>
      <option value="">{empty}</option>
      {shown({ kind: 'human', id: data.human.id }) && (
        <option value={'human:' + data.human.id}>
          {data.human.username} (human)
        </option>
      )}
      {data.agents
        .filter(
          (a) =>
            data.joinedAgentIds.includes(a.id) &&
            shown({ kind: 'agent', id: a.id }),
        )
        .map((a) => (
          <option value={'agent:' + a.id} key={a.id}>
            {a.name} (agent)
          </option>
        ))}
    </select>
  );
}
function MemberAvatar({
  member,
  data,
}: {
  member: Member | null;
  data: WorkspaceSnapshot;
}) {
  if (!member) return null;
  return (
    <Avatar kind={member.kind} name={memberName(member, data)} size="sm" />
  );
}
function MemberChip({
  member,
  data,
}: {
  member: Member | null;
  data: WorkspaceSnapshot;
}) {
  const name = memberName(member, data);
  return (
    <span className="member-chip" data-kind={member?.kind ?? 'none'}>
      {member && <Avatar kind={member.kind} name={name} size="sm" />}
      {name}
    </span>
  );
}
function TaskHistory({
  task,
  path,
  data,
}: {
  task: Task;
  path: string;
  data: WorkspaceSnapshot;
}) {
  const [history, setHistory] = useState<z.infer<typeof TaskEvent>[]>([]);
  const [links, setLinks] = useState<z.infer<typeof TaskExecution>[]>([]);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api(path + '/history', { signal: controller.signal }),
      api(path + '/executions', { signal: controller.signal }),
    ])
      .then(([events, refs]) => {
        setHistory(pageOf(TaskEvent).parse(events).items);
        setLinks(pageOf(TaskExecution).parse(refs).items);
        setError('');
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Activity unavailable. Refresh activity to retry.');
      });
    return () => {
      controller.abort();
    };
  }, [path, task.version, refresh]);
  return (
    <div className="task-history">
      <div className="drawer-heading">
        <h3>Decision history</h3>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setRefresh((value) => value + 1);
          }}
        >
          Refresh activity
        </button>
      </div>
      {error && <Notice>{error}</Notice>}
      <ol className="timeline">
        {history.map((e) => (
          <li key={e.id}>
            <time dateTime={e.createdAt}>{shortTime(e.createdAt)}</time>
            <span>
              <strong>{e.action}</strong> · {authorName(e.author, data)}
            </span>
            <small>v{e.version}</small>
          </li>
        ))}
      </ol>
      <h3>Execution references</h3>
      {links.length === 0 ? (
        <p className="muted">No executions linked.</p>
      ) : (
        links.map((link) => (
          <dl className="reference-list" key={link.id}>
            <dt>Environment</dt>
            <dd>{link.reference.environmentId}</dd>
            <dt>T3 Thread</dt>
            <dd>{link.reference.threadId}</dd>
            <dt>T3 Run</dt>
            <dd>
              {link.reference.runId ?? 'Thread reference; no Run recorded'}
            </dd>
          </dl>
        ))
      )}
    </div>
  );
}
type Intent =
  | 'claim'
  | 'progress'
  | 'request-review'
  | 'approve'
  | 'review-rework'
  | 'accept'
  | 'handoff'
  | 'rework'
  | 'cancel';
type Route = 'request-review' | 'handoff' | 'cancel';
const intentLabels: Record<Intent, string> = {
  claim: 'Claim task',
  progress: 'Post progress update',
  'request-review': 'Request review',
  approve: 'Approve review',
  'review-rework': 'Request changes',
  accept: 'Accept task',
  handoff: 'Assign work',
  rework: 'Request rework',
  cancel: 'Cancel task',
};
/** What the person sees after the server confirms the decision. */
const intentDone: Record<Intent, string> = {
  claim: 'Claimed. The task is in progress with you.',
  progress: 'Progress note recorded.',
  'request-review': 'Review requested.',
  approve: 'Review approved. It now waits for human sign-off.',
  'review-rework': 'Changes requested. The owner has it back.',
  accept: 'Accepted. Recorded with your note.',
  handoff: 'Work reassigned. Review restarts.',
  rework: 'Sent back for rework.',
  cancel: 'Task cancelled.',
};
const intentTone: Partial<Record<Intent, string>> = {
  accept: 'primary',
  approve: 'primary',
  rework: 'danger',
  'review-rework': 'danger',
  cancel: 'danger',
};
/** Explicit buttons per decision; the note is always written by the human. */
function DecisionPanel({
  task,
  data,
  path,
  onDone,
  onDecided,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  onDone: () => void;
  onDecided: (message: string) => void;
}) {
  const offline = useContext(Offline);
  const [routing, setRouting] = useState<Route | null>(null);
  const chosen = useRef<Intent | null>(null);
  // After a decision lands, buttons wait for the new task version so a second
  // click can never re-send against the old one.
  const [decidedAt, setDecidedAt] = useState<number | null>(null);
  const held = decidedAt === task.version;
  const human = { kind: 'human', id: data.human.id } satisfies Member;
  const owns =
    task.state.owner !== null &&
    memberKey(task.state.owner) === memberKey(human);
  const reviews =
    task.state.reviewer !== null &&
    memberKey(task.state.reviewer) === memberKey(human);
  const final = task.acceptorHumanId === data.human.id;
  const status = task.state.status;
  const done = status === 'accepted' || status === 'cancelled';
  const working = status === 'in-progress' || status === 'rework-requested';
  // Mirrors the server's task rules so no button leads to a certain 409/403.
  const intents: Intent[] = [];
  if (final && status === 'awaiting-human') intents.push('accept');
  if (reviews && status === 'review-requested')
    intents.push('approve', 'review-rework');
  if (!done && task.state.owner !== null && final) intents.push('rework');
  if (owns && working) intents.push('progress');
  const canClaim =
    status === 'proposed' &&
    (task.state.reviewer === null ||
      memberKey(task.state.reviewer) !== memberKey(human));
  const routes: Route[] = [];
  if (owns && status === 'in-progress') routes.push('request-review');
  if ((final && !done && task.state.owner !== null) || (owns && working))
    routes.push('handoff');
  if (final && !done) routes.push('cancel');
  if (!canClaim && intents.length === 0 && routes.length === 0)
    return (
      <p className="muted decision-none">
        {done
          ? 'This task is closed.'
          : 'Nothing is waiting on you here. Owner, reviewer and acceptor act from their own seats.'}
      </p>
    );
  const ask = humanAsk(task, data);
  // A recipient must differ from the current owner (work) or from you (review).
  const exclude =
    routing === 'handoff'
      ? task.state.owner
      : routing === 'request-review'
        ? human
        : null;
  return (
    <div className="decision-panel" data-ask={ask ? 'true' : undefined}>
      <ActionForm
        key={task.id}
        title={ask ? 'Your decision' : 'Task actions'}
        path={(f) => {
          const intent = value(f, 'intent');
          return (
            path +
            '/' +
            (intent === 'approve' || intent === 'review-rework'
              ? 'review'
              : intent)
          );
        }}
        onDone={() => {
          setRouting(null);
          setDecidedAt(task.version);
          if (chosen.current) onDecided(intentDone[chosen.current]);
          onDone();
        }}
        build={(f) => {
          const intent = value(f, 'intent');
          const base = {
            operationKey: crypto.randomUUID(),
            expectedVersion: task.version,
          };
          const command = TaskCommand.parse(
            intent === 'claim'
              ? { ...base, type: 'claim' }
              : intent === 'request-review'
                ? {
                    ...base,
                    type: intent,
                    note: value(f, 'note'),
                    reviewer: memberFrom(value(f, 'recipient')),
                  }
                : intent === 'handoff'
                  ? {
                      ...base,
                      type: intent,
                      note: value(f, 'note'),
                      mode: 'work',
                      recipient: memberFrom(value(f, 'recipient')),
                    }
                  : intent === 'approve' || intent === 'review-rework'
                    ? {
                        ...base,
                        type: 'review',
                        decision: intent === 'approve' ? 'approve' : 'rework',
                        note: value(f, 'note'),
                      }
                    : { ...base, type: intent, note: value(f, 'note') },
          );
          return Object.fromEntries(
            Object.entries(command).filter(
              ([key]) => key !== 'type' && key !== 'operationKey',
            ),
          );
        }}
      >
        {canClaim && !routing && (
          <SubmitGroup className="decision-buttons" held={held}>
            <button
              type="submit"
              name="intent"
              value="claim"
              formNoValidate
              className="primary"
              onClick={() => {
                chosen.current = 'claim';
              }}
            >
              {intentLabels.claim}
            </button>
          </SubmitGroup>
        )}
        {(routing === 'handoff' || routing === 'request-review') && (
          <Field label="Recipient">
            <MemberSelect
              name="recipient"
              data={data}
              required
              empty="Choose a joined member"
              exclude={exclude}
            />
          </Field>
        )}
        {routing === 'cancel' && (
          <p className="decision-warning">
            Cancelling closes the task without acceptance. It cannot be
            reopened.
          </p>
        )}
        {(routing !== null || intents.length > 0) && (
          <Field
            label={
              <>
                Decision note <span className="required">(required)</span>
              </>
            }
          >
            <textarea
              name="note"
              required
              maxLength={2000}
              rows={3}
              placeholder="Explain your decision"
            />
          </Field>
        )}
        {routing ? (
          <SubmitGroup className="decision-buttons" held={held}>
            <button
              type="submit"
              name="intent"
              value={routing}
              className={intentTone[routing] ?? 'primary'}
              onClick={() => {
                chosen.current = routing;
              }}
            >
              {intentLabels[routing]}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRouting(null);
              }}
            >
              Back
            </button>
          </SubmitGroup>
        ) : (
          <>
            {intents.length > 0 && (
              <SubmitGroup className="decision-buttons" held={held}>
                {intents.map((intent) => (
                  <button
                    key={intent}
                    type="submit"
                    name="intent"
                    value={intent}
                    className={intentTone[intent] ?? 'secondary'}
                    onClick={() => {
                      chosen.current = intent;
                    }}
                  >
                    {intentLabels[intent]}
                  </button>
                ))}
              </SubmitGroup>
            )}
            {routes.length > 0 && (
              <div className="route-buttons">
                {routes.map((route) => (
                  <button
                    key={route}
                    type="button"
                    className={
                      route === 'cancel' ? 'quiet subtle-danger' : 'quiet'
                    }
                    onClick={() => {
                      setRouting(route);
                    }}
                  >
                    {intentLabels[route]}…
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {offline ? (
          <p className="decision-help">
            Actions are paused until the workspace reconnects.
          </p>
        ) : (
          final &&
          status === 'awaiting-human' && (
            <p className="decision-help">
              Only you can accept this task. Acceptance is recorded with your
              note.
            </p>
          )
        )}
      </ActionForm>
    </div>
  );
}
export function TaskDrawer({
  task,
  data,
  path,
  onDone,
  onClose,
  onDecided,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  onDone: () => void;
  onClose: () => void;
  onDecided: (message: string) => void;
}) {
  const topic = task.topicId
    ? data.topics.items.find((t) => t.id === task.topicId)
    : undefined;
  const acceptor = { kind: 'human', id: task.acceptorHumanId } satisfies Member;
  return (
    <Drawer label={task.title} onClose={onClose} className="task-drawer">
      <div className="drawer-body" data-status={task.state.status}>
        <header className="drawer-header">
          <span className="task-number">#{task.position}</span>
          <StatusChip status={task.state.status} />
          <small>v{task.version}</small>
        </header>
        <h2>{task.title}</h2>
        {task.description && (
          <p className="task-description">{task.description}</p>
        )}
        {topic && <span className="topic-pill static">{topic.title}</span>}
        <Lifecycle status={task.state.status} />
        <dl className="people-list">
          <dt>Owner</dt>
          <dd>
            <MemberChip member={task.state.owner} data={data} />
          </dd>
          <dt>Reviewer</dt>
          <dd>
            <MemberChip member={task.state.reviewer} data={data} />
          </dd>
          <dt>Acceptor</dt>
          <dd>
            <MemberChip member={acceptor} data={data} />
          </dd>
        </dl>
        <h3>Acceptance criteria</h3>
        <ol className="criteria">
          {task.criteria.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        {task.state.note && (
          <figure className="task-note">
            <figcaption>Latest note</figcaption>
            <blockquote>{task.state.note}</blockquote>
          </figure>
        )}
        <DecisionPanel
          task={task}
          data={data}
          path={path}
          onDone={onDone}
          onDecided={onDecided}
        />
        <TaskHistory task={task} path={path} data={data} />
      </div>
    </Drawer>
  );
}
function TaskCard({
  task,
  data,
  selected,
  onOpen,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  selected: boolean;
  onOpen: () => void;
}) {
  const ask = humanAsk(task, data);
  return (
    <article
      className="task-card"
      data-status={task.state.status}
      data-ask={ask ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      aria-label={task.title}
      ref={(el) => {
        // Lets a status change travel between columns as one element.
        el?.style.setProperty('view-transition-name', 'task-' + task.id);
      }}
    >
      <header>
        <span className="task-number">#{task.position}</span>
        <StatusChip status={task.state.status} />
      </header>
      <h3>
        <button
          type="button"
          className="card-link"
          aria-expanded={selected}
          onClick={onOpen}
        >
          {task.title}
        </button>
      </h3>
      {ask && <p className="ask-label">{ask}</p>}
      <Lifecycle status={task.state.status} compact />
      <footer>
        <span className="card-people">
          <MemberAvatar member={task.state.owner} data={data} />
          <MemberAvatar member={task.state.reviewer} data={data} />
        </span>
        <small>
          {task.criteria.length === 1
            ? '1 criterion'
            : `${String(task.criteria.length)} criteria`}
          {' · '}
          <time dateTime={task.updatedAt} title="Last change">
            {age(task.updatedAt)}
          </time>
        </small>
      </footer>
    </article>
  );
}
export interface TaskDraft {
  id: string;
  title: string;
  description: string;
  topicId: string | null;
  sourceMessageId: string | null;
  from: string | null;
}
export function draftFromMessage(
  message: z.infer<typeof Message>,
  data: WorkspaceSnapshot,
): TaskDraft {
  const firstLine = message.body.trim().split('\n')[0] ?? '';
  return {
    id: message.id,
    title: firstLine.slice(0, 160),
    description: message.body.slice(0, 4000),
    topicId: message.topicId,
    sourceMessageId: message.id,
    from: authorName(message.author, data),
  };
}
export type BoardFilter = 'all' | 'mine' | 'needs';
const filters: { id: BoardFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'needs', label: 'Needs me' },
];
export function Board({
  data,
  channelPath,
  onDone,
  next,
  openTask,
  selected,
  filter,
  onFilter,
  draft,
  onDraft,
  onNotify,
}: {
  data: WorkspaceSnapshot;
  channelPath: string;
  onDone: () => void;
  next: () => void;
  openTask: (id: string) => void;
  selected: string | null;
  filter: BoardFilter;
  onFilter: (filter: BoardFilter) => void;
  draft: TaskDraft | null;
  onDraft: (draft: TaskDraft | null) => void;
  onNotify: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const me = memberKey({ kind: 'human', id: data.human.id });
  const items = data.tasks.items.filter((t) =>
    filter === 'needs'
      ? humanAsk(t, data) !== null
      : filter === 'mine'
        ? [t.state.owner, t.state.reviewer].some(
            (m) => m !== null && memberKey(m) === me,
          ) || t.acceptorHumanId === data.human.id
        : true,
  );
  const byStatus = new Map<Status, Task[]>(statuses.map((s) => [s.id, []]));
  for (const task of items) byStatus.get(task.state.status)?.push(task);
  const firstAsk = statuses.find((s) =>
    byStatus.get(s.id)?.some((t) => humanAsk(t, data)),
  );
  const [column, setColumn] = useState<Status>(firstAsk?.id ?? 'proposed');
  const closed = data.tasks.items.filter(
    (t) => t.state.status === 'accepted' || t.state.status === 'cancelled',
  ).length;
  const open = creating || draft !== null;
  return (
    <section className="board-view" aria-label="Task board">
      <div className="section-heading">
        <div>
          <h2>Board</h2>
          <span>
            {data.tasks.items.length - closed} open · {closed} closed
          </span>
        </div>
        <div className="filter-pills" role="group" aria-label="Task filter">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => {
                onFilter(f.id);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <details
        className="create-panel"
        open={open}
        onToggle={(e) => {
          const isOpen = e.currentTarget.open;
          setCreating(isOpen);
          if (!isOpen) onDraft(null);
        }}
      >
        <summary>Create task</summary>
        {draft?.from && (
          <p className="draft-source">
            From a message by {draft.from}. The task links back to it.
          </p>
        )}
        <ActionForm
          key={draft?.id ?? 'blank'}
          title="New task"
          path={channelPath + '/tasks'}
          onDone={() => {
            onNotify(
              draft ? 'Task created from the message.' : 'Task created.',
            );
            onDraft(null);
            onDone();
          }}
          submit="Create task"
          build={(f) => {
            const input = TaskCreate.parse({
              operationKey: crypto.randomUUID(),
              title: value(f, 'title'),
              description: value(f, 'description'),
              criteria: value(f, 'criteria')
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
              owner: memberFrom(value(f, 'owner')),
              reviewer: memberFrom(value(f, 'reviewer')),
              topicId: draft?.topicId ?? null,
              sourceMessageId: draft?.sourceMessageId ?? null,
              sourceEventId: null,
            });
            return Object.fromEntries(
              Object.entries(input).filter(([key]) => key !== 'operationKey'),
            );
          }}
        >
          <Field label="Task title">
            <input
              name="title"
              required
              maxLength={160}
              defaultValue={draft?.title}
            />
          </Field>
          <Field label="Description">
            <textarea
              name="description"
              maxLength={4000}
              defaultValue={draft?.description}
            />
          </Field>
          <Field label="Acceptance criteria (one per line)">
            <textarea name="criteria" required />
          </Field>
          <div className="field-row">
            <Field label="Owner">
              <MemberSelect name="owner" data={data} />
            </Field>
            <Field label="Reviewer">
              <MemberSelect name="reviewer" data={data} />
            </Field>
          </div>
        </ActionForm>
      </details>
      <div className="column-switcher" role="group" aria-label="Status columns">
        {statuses.map((s) => (
          <button
            key={s.id}
            type="button"
            data-status={s.id}
            aria-pressed={column === s.id}
            onClick={() => {
              setColumn(s.id);
            }}
          >
            {s.label}
            <span className="count">{byStatus.get(s.id)?.length ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="board">
        {statuses.map((s) => {
          const tasks = byStatus.get(s.id) ?? [];
          return (
            <section
              key={s.id}
              className="board-column"
              data-status={s.id}
              data-current={column === s.id ? 'true' : undefined}
              aria-label={s.label}
            >
              <h3 className="column-heading">
                <span className="dot" aria-hidden="true" />
                {s.label}
                <span className="count">{tasks.length}</span>
              </h3>
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  data={data}
                  selected={selected === task.id}
                  onOpen={() => {
                    openTask(task.id);
                  }}
                />
              ))}
              {tasks.length === 0 && <p className="column-empty">Empty</p>}
            </section>
          );
        })}
      </div>
      {data.tasks.items.length === 0 && (
        <div className="empty">
          <h3>No promises yet</h3>
          <p>
            A task turns a conversation into a clear next step, with a human
            sign-off at the end. Create one here or from any message.
          </p>
        </div>
      )}
      {data.tasks.nextCursor && (
        <button className="quiet page-control" onClick={next}>
          Next tasks page
        </button>
      )}
    </section>
  );
}
