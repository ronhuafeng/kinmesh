import { authorName } from './names.js';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import {
  TaskCommand,
  TaskCreate,
  TaskEvent,
  TaskExecution,
} from '../src/domain/tasks.js';
import type { Task } from '../src/domain/tasks.js';
import { Member, memberKey, pageOf } from '../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, value } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';

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
    return 'Accept or send back';
  if (status === 'review-requested' && memberKey(reviewer) === me)
    return 'Review requested';
  if (status === 'rework-requested' && memberKey(owner) === me)
    return 'Rework requested';
  return null;
}
const stages = [
  { label: 'Proposed', statuses: ['proposed'] },
  { label: 'Working', statuses: ['in-progress', 'rework-requested'] },
  { label: 'Review', statuses: ['review-requested'] },
  { label: 'Human sign-off', statuses: ['awaiting-human'] },
  { label: 'Done', statuses: ['accepted'] },
];
function Lifecycle({ status }: { status: Task['state']['status'] }) {
  const current = stages.findIndex((s) => s.statuses.includes(status));
  if (current < 0) return null;
  return (
    <ol className="lifecycle" aria-label="Task progress">
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
}: {
  name: string;
  id?: string;
  data: WorkspaceSnapshot;
  required?: boolean;
  empty?: string;
}) {
  return (
    <select id={id} name={name} required={required} defaultValue="">
      <option value="">{empty}</option>
      <option value={'human:' + data.human.id}>
        {data.human.username} (human)
      </option>
      {data.agents
        .filter((a) => data.joinedAgentIds.includes(a.id))
        .map((a) => (
          <option value={'agent:' + a.id} key={a.id}>
            {a.name} (agent)
          </option>
        ))}
    </select>
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
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Activity unavailable. Reopen to retry.');
      });
    return () => {
      controller.abort();
    };
  }, [path, task.version, refresh]);
  return (
    <div className="task-history">
      <button
        type="button"
        className="quiet"
        onClick={() => {
          setRefresh((value) => value + 1);
        }}
      >
        Refresh activity
      </button>
      {error && <Notice>{error}</Notice>}
      <h4>Decision history</h4>
      <ol>
        {history.map((e) => (
          <li key={e.id}>
            <strong>{e.action}</strong> · {authorName(e.author, data)} · version{' '}
            {e.version}
            <small>{new Date(e.createdAt).toLocaleString()}</small>
          </li>
        ))}
      </ol>
      <h4>Execution references</h4>
      {links.length === 0 ? (
        <p>No executions linked.</p>
      ) : (
        links.map((link) => (
          <p className="reference" key={link.id}>
            {link.reference.environmentId}
            <br />
            {link.reference.threadId}
            <br />
            {link.reference.runId ?? 'Thread reference; no Run recorded'}
          </p>
        ))
      )}
    </div>
  );
}
function TaskCard({
  task,
  data,
  path,
  onDone,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  onDone: () => void;
}) {
  const [history, setHistory] = useState(false);
  const [action, setAction] = useState('');
  const human = { kind: 'human', id: data.human.id } satisfies Member;
  const owns =
    task.state.owner !== null &&
    memberKey(task.state.owner) === memberKey(human);
  const reviews =
    task.state.reviewer !== null &&
    memberKey(task.state.reviewer) === memberKey(human);
  const final = task.acceptorHumanId === data.human.id;
  const done = ['accepted', 'cancelled'].includes(task.state.status);
  const actions: { value: string; label: string }[] = [];
  if (task.state.status === 'proposed' && !reviews)
    actions.push({ value: 'claim', label: 'Claim task' });
  if (owns && ['in-progress', 'rework-requested'].includes(task.state.status))
    actions.push({ value: 'progress', label: 'Update progress' });
  if (owns && task.state.status === 'in-progress')
    actions.push({ value: 'request-review', label: 'Request review' });
  if (reviews && task.state.status === 'review-requested')
    actions.push(
      { value: 'approve', label: 'Approve review' },
      { value: 'review-rework', label: 'Request changes' },
    );
  if (final && task.state.status === 'awaiting-human')
    actions.push({ value: 'accept', label: 'Accept task' });
  if (!done && task.state.owner !== null && (final || owns))
    actions.push({ value: 'handoff', label: 'Assign work' });
  if (!done && task.state.owner !== null && final)
    actions.push({ value: 'rework', label: 'Request rework' });
  const selected = actions.some((a) => a.value === action)
    ? action
    : (actions[0]?.value ?? '');
  const route =
    selected === 'approve' || selected === 'review-rework'
      ? 'review'
      : selected;
  return (
    <article
      className="task-card"
      data-status={task.state.status}
      data-ask={humanAsk(task, data) ? 'true' : undefined}
      aria-label={task.title}
    >
      <header>
        <span className={'badge ' + task.state.status}>
          {task.state.status}
        </span>
        <small>v{task.version}</small>
      </header>
      <h3>{task.title}</h3>
      <Lifecycle status={task.state.status} />
      {task.description && <p>{task.description}</p>}
      <ul className="criteria">
        {task.criteria.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <dl>
        <dt>Owner</dt>
        <dd>{memberName(task.state.owner, data)}</dd>
        <dt>Reviewer</dt>
        <dd>{memberName(task.state.reviewer, data)}</dd>
      </dl>
      {task.state.note && <p className="task-note">{task.state.note}</p>}
      {actions.length > 0 && (
        <ActionForm
          key={selected}
          title="Task action"
          path={path + '/' + route}
          submit={
            actions.find((a) => a.value === selected)?.label ?? 'Apply action'
          }
          onDone={onDone}
          build={(f) => {
            const base = {
              operationKey: crypto.randomUUID(),
              expectedVersion: task.version,
            };
            const command = TaskCommand.parse(
              selected === 'claim'
                ? { ...base, type: 'claim' }
                : selected === 'request-review'
                  ? {
                      ...base,
                      type: selected,
                      note: value(f, 'note'),
                      reviewer: memberFrom(value(f, 'recipient')),
                    }
                  : selected === 'handoff'
                    ? {
                        ...base,
                        type: selected,
                        note: value(f, 'note'),
                        mode: 'work',
                        recipient: memberFrom(value(f, 'recipient')),
                      }
                    : selected === 'approve' || selected === 'review-rework'
                      ? {
                          ...base,
                          type: 'review',
                          decision:
                            selected === 'approve' ? 'approve' : 'rework',
                          note: value(f, 'note'),
                        }
                      : { ...base, type: selected, note: value(f, 'note') },
            );
            return Object.fromEntries(
              Object.entries(command).filter(
                ([key]) => key !== 'type' && key !== 'operationKey',
              ),
            );
          }}
        >
          <Field label="Action">
            <select
              value={selected}
              onChange={(e) => {
                setAction(e.target.value);
              }}
            >
              {actions.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
          {['request-review', 'handoff'].includes(selected) && (
            <Field label="Recipient">
              <MemberSelect
                name="recipient"
                data={data}
                required
                empty="Choose a joined member"
              />
            </Field>
          )}
          {selected !== 'claim' && (
            <Field label="Decision note">
              <textarea name="note" required maxLength={2000} rows={2} />
            </Field>
          )}
        </ActionForm>
      )}
      <button
        className="quiet"
        type="button"
        aria-expanded={history}
        onClick={() => {
          setHistory(!history);
        }}
      >
        {history ? 'Hide activity' : 'Show activity'}
      </button>
      {history && <TaskHistory task={task} path={path} data={data} />}
    </article>
  );
}
export function Tasks({
  data,
  channelPath,
  onDone,
  next,
}: {
  data: WorkspaceSnapshot;
  channelPath: string;
  onDone: () => void;
  next: () => void;
}) {
  const items = data.tasks.items;
  const isClosed = (t: Task) =>
    t.state.status === 'accepted' || t.state.status === 'cancelled';
  const needs = items.filter((t) => humanAsk(t, data) !== null);
  const closed = items.filter(isClosed);
  const moving = items.filter((t) => !isClosed(t) && !needs.includes(t));
  const open = items.length - closed.length;
  const lanes = [
    { id: 'needs', title: 'Needs you', tasks: needs },
    { id: 'moving', title: 'In motion', tasks: moving },
    { id: 'closed', title: 'Closed', tasks: closed },
  ];
  return (
    <section className="tasks-view">
      <div className="section-heading">
        <h2>Tasks</h2>
        <span>
          {open} open · {closed.length} closed
        </span>
      </div>
      <details className="create-panel">
        <summary>Create task</summary>
        <ActionForm
          title="New task"
          path={channelPath + '/tasks'}
          onDone={onDone}
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
              topicId: null,
              sourceMessageId: null,
              sourceEventId: null,
            });
            return Object.fromEntries(
              Object.entries(input).filter(([key]) => key !== 'operationKey'),
            );
          }}
        >
          <Field label="Task title">
            <input name="title" required maxLength={160} />
          </Field>
          <Field label="Description">
            <textarea name="description" maxLength={4000} />
          </Field>
          <Field label="Acceptance criteria (one per line)">
            <textarea name="criteria" required />
          </Field>
          <Field label="Owner">
            <MemberSelect name="owner" data={data} />
          </Field>
          <Field label="Reviewer">
            <MemberSelect name="reviewer" data={data} />
          </Field>
        </ActionForm>
      </details>
      {lanes.map(
        (lane) =>
          lane.tasks.length > 0 && (
            <section
              className="task-lane"
              data-lane={lane.id}
              key={lane.id}
              aria-label={lane.title}
            >
              <h3 className="lane-heading">
                {lane.title} <span>{lane.tasks.length}</span>
              </h3>
              <div className="task-grid">
                {lane.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    data={data}
                    path={channelPath + '/tasks/' + task.id}
                    onDone={onDone}
                  />
                ))}
              </div>
            </section>
          ),
      )}
      {data.tasks.items.length === 0 && (
        <div className="empty">
          <h3>No promises yet</h3>
          <p>
            A task turns a conversation into a clear next step, with a human
            sign-off at the end.
          </p>
        </div>
      )}
      {data.tasks.nextCursor && <button onClick={next}>Next tasks page</button>}
    </section>
  );
}
