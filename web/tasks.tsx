import { useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import { z as zod } from 'zod';
import { keep, kept } from './session.js';
import {
  TaskCommand,
  TaskCreate,
  TaskEvent,
  TaskExecution,
  TaskResult,
} from '../src/domain/tasks.js';
import type { Task } from '../src/domain/tasks.js';
import { Member, memberKey, pageOf } from '../src/domain/communication.js';
import type { Message } from '../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, Offline, value } from './api.js';
import { ActionForm, Field, Notice, SubmitGroup } from './forms.js';
import { DeliveryLine, taskDeliveries } from './deliveries.js';
import { joinedAgents, memberName, someoneOf } from './names.js';
import type { Someone } from './names.js';
import { LEGACY_FOOTER } from './replies.js';
import { Avatar, Page, shortTime } from './ui.js';
import { PlusIcon } from './icons.js';
import type { Status } from './ui.js';

/** A member chosen in a picker, written there as "kind:id". */
function memberFrom(value: string): Member | null {
  if (!value) return null;
  const [kind, id] = value.split(':');
  return Member.parse({ kind, id });
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
/**
 * One model for the board and the lifecycle: five stages a person can follow.
 * Rework is still Working (marked "Sent back"); cancelled work is Done
 * (marked "Cancelled", hidden by default).
 */
type StageId = 'proposed' | 'working' | 'review' | 'sign-off' | 'done';
const stages: readonly {
  id: StageId;
  label: string;
  /** For the narrow progress bar on the task page. */
  short?: string;
  /** Reuses the status colour token of the stage's main status. */
  tone: Status;
  statuses: readonly Status[];
}[] = [
  {
    id: 'proposed',
    label: 'Proposed',
    tone: 'proposed',
    statuses: ['proposed'],
  },
  {
    id: 'working',
    label: 'Working',
    tone: 'in-progress',
    statuses: ['in-progress', 'rework-requested'],
  },
  {
    id: 'review',
    label: 'Review',
    tone: 'review-requested',
    statuses: ['review-requested'],
  },
  {
    id: 'sign-off',
    label: 'Human sign-off',
    short: 'Sign-off',
    tone: 'awaiting-human',
    statuses: ['awaiting-human'],
  },
  {
    id: 'done',
    label: 'Done',
    tone: 'accepted',
    statuses: ['accepted', 'cancelled'],
  },
];
function stageOf(status: Status): StageId {
  return stages.find((s) => s.statuses.includes(status))?.id ?? 'proposed';
}
/** The one exception a card states in words; the column says the rest. */
function cardMarker(status: Status) {
  return status === 'rework-requested'
    ? 'Sent back'
    : status === 'cancelled'
      ? 'Cancelled'
      : null;
}
/** A status as people say it: its stage, or the exception a card names. */
export function statusLabel(status: Status) {
  return (
    cardMarker(status) ??
    stages.find((s) => s.statuses.includes(status))?.label ??
    status
  );
}
function StatusChip({ status }: { status: Status }) {
  return (
    <span className="status-chip" data-status={status}>
      {statusLabel(status)}
    </span>
  );
}
function Lifecycle({ status }: { status: Status }) {
  if (status === 'cancelled') return null;
  const current = stages.findIndex((s) => s.id === stageOf(status));
  return (
    <ol className="lifecycle" aria-label="Task progress">
      {stages.map((stage, index) => (
        <li
          key={stage.id}
          data-step={
            index < current || status === 'accepted'
              ? 'done'
              : index === current
                ? 'current'
                : 'todo'
          }
          aria-current={index === current ? 'step' : undefined}
        >
          <span title={stage.label}>{stage.short ?? stage.label}</span>
        </li>
      ))}
    </ol>
  );
}
/** The people a task can go to: you and the channel's agents, as "kind:id". */
function MemberOptions({
  data,
  exclude = null,
}: {
  data: WorkspaceSnapshot;
  exclude?: Member | null;
}) {
  const shown = (member: Member) =>
    exclude === null || memberKey(member) !== memberKey(exclude);
  return (
    <>
      {shown({ kind: 'human', id: data.human.id }) && (
        <option value={'human:' + data.human.id}>{data.human.username}</option>
      )}
      {joinedAgents(data)
        .filter((a) => shown({ kind: 'agent', id: a.id }))
        .map((a) => (
          <option value={'agent:' + a.id} key={a.id}>
            {a.name}
          </option>
        ))}
    </>
  );
}
function MemberSelect({
  name,
  data,
  required = false,
  empty = 'Unassigned',
  exclude = null,
}: {
  name: string;
  data: WorkspaceSnapshot;
  required?: boolean;
  empty?: string;
  exclude?: Member | null;
}) {
  return (
    <select name={name} required={required} defaultValue="">
      <option value="">{empty}</option>
      <MemberOptions data={data} exclude={exclude} />
    </select>
  );
}
function MemberAvatar({
  member,
  data,
}: {
  member: Someone | null;
  data: WorkspaceSnapshot;
}) {
  if (!member) return null;
  return (
    <Avatar
      kind={member.kind}
      name={memberName(member, data)}
      id={member.id}
      size="sm"
    />
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
      {member && (
        <Avatar kind={member.kind} name={name} id={member.id} size="sm" />
      )}
      {name}
    </span>
  );
}
const quote = (note: string) =>
  ': “' + (note.length > 120 ? note.slice(0, 117) + '…' : note) + '”';
/** One line of task history as a person would say it. */
export function historySentence(
  e: z.infer<typeof TaskEvent>,
  data: WorkspaceSnapshot,
): string {
  const who =
    e.author.kind === 'human' && e.author.humanId === data.human.id
      ? 'You'
      : memberName(e.author, data);
  const name = (m: Member) =>
    m.kind === 'human' && m.id === data.human.id ? 'you' : memberName(m, data);
  const c = e.command;
  switch (c.type) {
    case 'create':
      return `${who} created the task`;
    case 'claim':
      return `${who} took it on`;
    case 'progress':
      return `${who} posted progress${quote(c.note)}`;
    case 'handoff': {
      const self =
        e.author.kind === c.recipient.kind &&
        (e.author.kind === 'human' ? e.author.humanId : e.author.agentId) ===
          c.recipient.id;
      return c.mode === 'review'
        ? `${who} asked ${name(c.recipient)} to review${quote(c.note)}`
        : self
          ? `${who} took over the work${quote(c.note)}`
          : `${who} handed the work to ${name(c.recipient)}${quote(c.note)}`;
    }
    case 'request-review':
      return `${who} asked ${name(c.reviewer)} to review${quote(c.note)}`;
    case 'review':
      return c.decision === 'approve'
        ? `${who} approved the review${quote(c.note)}`
        : `${who} asked for changes${quote(c.note)}`;
    case 'accept':
      return `${who} accepted it${quote(c.note)}`;
    case 'rework':
      return `${who} sent it back${quote(c.note)}`;
    case 'cancel':
      return `${who} cancelled it${quote(c.note)}`;
    case 'link-execution':
      return `${who} linked a T3 run`;
  }
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
  const avatarOf = (author: z.infer<typeof TaskEvent>['author']) => (
    <MemberAvatar member={someoneOf(author)} data={data} />
  );
  // Decisions and linked T3 runs, one timeline, oldest first.
  const lines = [
    ...history.map((e) => ({
      key: e.id,
      at: e.createdAt,
      who: avatarOf(e.author),
      text: historySentence(e, data),
      refs: null as null | { thread: string; run: string | null },
    })),
    ...links.map((link) => ({
      key: link.id,
      at: link.createdAt,
      who: avatarOf(link.author),
      text: 'Linked a T3 run',
      refs: { thread: link.reference.threadId, run: link.reference.runId },
    })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  return (
    <section className="task-history" aria-label="History">
      <div className="page-heading">
        <h3>History</h3>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setRefresh((value) => value + 1);
          }}
        >
          Refresh
        </button>
      </div>
      {error && <Notice>{error}</Notice>}
      <ol className="history">
        {lines.map((line) => (
          <li key={line.key}>
            <time dateTime={line.at}>{shortTime(line.at)}</time>
            {line.who}
            <span>
              {line.text}
              {line.refs && (
                <code className="run-ref" title={line.refs.thread}>
                  {' '}
                  {line.refs.thread}
                  {line.refs.run ? ' ' + line.refs.run : ''}
                </code>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
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
/** Moving on is the plain (green) button; sending back or away is danger. */
const intentTone: Partial<Record<Intent, string>> = {
  progress: 'secondary',
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
  // Nothing to do here: say so only when the task is over.
  if (!canClaim && intents.length === 0 && routes.length === 0)
    return done ? (
      <p className="muted decision-none">This task is closed.</p>
    ) : null;
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
          <Field label="Decision note">
            <textarea
              name="note"
              className="decision-note"
              required
              maxLength={2000}
              rows={1}
              placeholder="Note for the record"
            />
          </Field>
        )}
        {routing ? (
          <SubmitGroup className="decision-buttons" held={held}>
            <button
              type="submit"
              name="intent"
              value={routing}
              className={intentTone[routing]}
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
                    className={intentTone[intent]}
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
        {offline && (
          <p className="decision-help">
            Actions are paused until the workspace reconnects.
          </p>
        )}
      </ActionForm>
    </div>
  );
}
/**
 * "Done when", written as the checklist it becomes: one condition per row,
 * Enter starts the next, Backspace on an empty row removes it.
 */
function CriteriaInput({ initial }: { initial: string[] }) {
  const [rows, setRows] = useState(initial.length > 0 ? initial : ['']);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = useRef<number | null>(null);
  useEffect(() => {
    if (focus.current === null) return;
    inputs.current[focus.current]?.focus();
    focus.current = null;
  }, [rows.length]);
  const placeholders = ['Tests pass', 'Docs updated'];
  return (
    <ul className="criteria-input">
      {rows.map((row, index) => (
        <li key={index}>
          <input
            ref={(el) => {
              inputs.current[index] = el;
            }}
            name="criteria"
            aria-label={
              index === 0 ? 'Done when' : `Done when ${String(index + 1)}`
            }
            required={index === 0}
            maxLength={500}
            placeholder={placeholders[index] ?? ''}
            value={row}
            onChange={(e) => {
              const next = e.target.value;
              setRows((old) => old.map((v, i) => (i === index ? next : v)));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                focus.current = index + 1;
                setRows((old) => [
                  ...old.slice(0, index + 1),
                  '',
                  ...old.slice(index + 1),
                ]);
              } else if (
                e.key === 'Backspace' &&
                row === '' &&
                rows.length > 1
              ) {
                e.preventDefault();
                focus.current = Math.max(0, index - 1);
                setRows((old) => old.filter((_, i) => i !== index));
              }
            }}
          />
        </li>
      ))}
      <li>
        <button
          type="button"
          className="quiet add-criterion"
          aria-label="Add a condition"
          onClick={() => {
            focus.current = rows.length;
            setRows((old) => [...old, '']);
          }}
        >
          <PlusIcon />
        </button>
      </li>
    </ul>
  );
}
/** Choosing a person: their face, or an empty one, and their name. */
function PersonPicker({
  name,
  label,
  data,
  initial,
}: {
  name: string;
  label: string;
  data: WorkspaceSnapshot;
  initial: string;
}) {
  const [chosen, setChosen] = useState(initial);
  const member = chosen ? memberFrom(chosen) : null;
  return (
    <span className="person-picker">
      {member ? (
        <MemberAvatar member={member} data={data} />
      ) : (
        <span className="avatar-empty" aria-hidden="true">
          <PlusIcon />
        </span>
      )}
      <select
        name={name}
        aria-label={label}
        value={chosen}
        onChange={(e) => {
          setChosen(e.target.value);
        }}
      >
        <option value="">Choose…</option>
        <MemberOptions data={data} />
      </select>
    </span>
  );
}
/**
 * A new task is the task page before it exists: the same places, empty and
 * editable. Created, it stays on screen as the task itself.
 */
export function NewTaskPage({
  draft,
  data,
  channelPath,
  onClose,
  onCreated,
  onNotify,
}: {
  draft: TaskDraft;
  data: WorkspaceSnapshot;
  channelPath: string;
  onClose: () => void;
  onCreated: (taskId: string) => void;
  onNotify: (message: string) => void;
}) {
  const topic = draft.topicId
    ? data.topics.items.find((t) => t.id === draft.topicId)
    : undefined;
  // What was typed before a reload comes back in its place.
  const restored = keptDraft();
  const typed = restored?.draft.id === draft.id ? restored.fields : {};
  return (
    <Page label="New task" onClose={onClose} className="task-page">
      <div
        className="page-body"
        onInput={(e) => {
          const form =
            e.target instanceof HTMLElement ? e.target.closest('form') : null;
          if (!form) return;
          const fields: Record<string, string> = {};
          for (const [key, entry] of new FormData(form))
            if (typeof entry === 'string')
              fields[key] =
                key === 'criteria' && fields[key] !== undefined
                  ? fields[key] + '\n' + entry
                  : entry;
          keepDraft(draft, fields);
        }}
      >
        <ActionForm
          key={draft.id}
          title="New task"
          path={channelPath + '/tasks'}
          onDone={() => {
            onNotify(
              draft.from ? 'Task created from the message.' : 'Task created.',
            );
          }}
          onResult={(raw) => {
            const created = TaskResult.safeParse(raw);
            if (created.success) onCreated(created.data.task.id);
          }}
          build={(f) => {
            const input = TaskCreate.parse({
              operationKey: crypto.randomUUID(),
              title: value(f, 'title'),
              description: value(f, 'description'),
              criteria: f
                .getAll('criteria')
                .map((c) => (typeof c === 'string' ? c.trim() : ''))
                .filter(Boolean),
              owner: memberFrom(value(f, 'owner')),
              reviewer: memberFrom(value(f, 'reviewer')),
              topicId: draft.topicId,
              sourceMessageId: draft.sourceMessageId,
              sourceEventId: null,
            });
            return Object.fromEntries(
              Object.entries(input).filter(([key]) => key !== 'operationKey'),
            );
          }}
        >
          <TaskLayout
            status="proposed"
            lead={
              draft.from ? (
                <p className="draft-source">From {draft.from}’s message</p>
              ) : null
            }
            title={
              <Field label="Task title">
                <input
                  name="title"
                  className="title-input"
                  required
                  maxLength={160}
                  placeholder="What needs doing?"
                  defaultValue={typed.title ?? draft.title}
                  autoFocus
                />
              </Field>
            }
            description={
              <Field label="Description">
                <textarea
                  name="description"
                  className="description-input"
                  rows={3}
                  maxLength={4000}
                  placeholder="Add a description"
                  defaultValue={typed.description ?? draft.description}
                />
              </Field>
            }
            criteria={
              <CriteriaInput
                initial={(typed.criteria ?? '').split('\n').filter(Boolean)}
              />
            }
            owner={
              <PersonPicker
                name="owner"
                label="Owner"
                data={data}
                initial={typed.owner ?? ''}
              />
            }
            reviewer={
              <PersonPicker
                name="reviewer"
                label="Reviewer"
                data={data}
                initial={typed.reviewer ?? ''}
              />
            }
            acceptor={
              <MemberChip
                member={{ kind: 'human', id: data.human.id }}
                data={data}
              />
            }
            topic={topic?.title ?? null}
          >
            <button type="submit" className="create-task">
              Create task
            </button>
          </TaskLayout>
        </ActionForm>
      </div>
    </Page>
  );
}
/**
 * One layout for a task, new or existing: progress across the top, the
 * title and description, then what "done" means and what happens next on
 * the left, and the people on the right.
 */
function TaskLayout({
  status,
  lead,
  title,
  description,
  criteria,
  owner,
  reviewer,
  acceptor,
  topic,
  decision,
  children,
}: {
  status: Status;
  lead?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  criteria: ReactNode;
  owner: ReactNode;
  reviewer: ReactNode;
  acceptor: ReactNode;
  topic: string | null;
  /** What waits on you: first, above everything else in the task. */
  decision?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="task-layout" data-status={status}>
      {/* Progress says where the task is; a cancelled one has none. */}
      {status === 'cancelled' ? (
        <StatusChip status={status} />
      ) : (
        <Lifecycle status={status} />
      )}
      {lead}
      <div className="task-title">{title}</div>
      {description}
      <div className="task-columns">
        <div className="task-main">
          {decision}
          <section className="task-criteria">
            <h3>Done when</h3>
            {criteria}
          </section>
          {children}
        </div>
        <aside className="task-side" aria-label="People">
          <dl className="people-list">
            <dt>Owner</dt>
            <dd>{owner}</dd>
            <dt>Reviewer</dt>
            <dd>{reviewer}</dd>
            <dt>Acceptor</dt>
            <dd>{acceptor}</dd>
          </dl>
          {topic && <span className="topic-pill static">{topic}</span>}
        </aside>
      </div>
    </div>
  );
}
/**
 * The decision that waits on you, marked in orange, led by the latest note
 * that brought it here. Without one, only the actions you may take.
 */
function TaskDecision({
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
  const ask = humanAsk(task, data);
  return (
    <div className="task-decision" data-ask={ask ? 'true' : undefined}>
      {/* The note leads only a decision; otherwise History already says it. */}
      {ask && task.state.note && (
        <p className="task-decision-note">
          <strong>{ask}</strong>
          <q>{task.state.note}</q>
        </p>
      )}
      <DecisionPanel
        task={task}
        data={data}
        path={path}
        onDone={onDone}
        onDecided={onDecided}
      />
    </div>
  );
}
const withAgents = (status: Status) =>
  status === 'in-progress' ||
  status === 'review-requested' ||
  status === 'rework-requested';
export function TaskPage({
  task,
  data,
  path,
  onDone,
  onClose,
  onDecided,
  openAgent,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  onDone: () => void;
  onClose: () => void;
  onDecided: (message: string) => void;
  openAgent: (agentId: string) => void;
}) {
  const topic = task.topicId
    ? data.topics.items.find((t) => t.id === task.topicId)
    : undefined;
  const acceptor = { kind: 'human', id: task.acceptorHumanId } satisfies Member;
  return (
    <Page label={task.title} onClose={onClose} className="task-page">
      <div className="page-body" data-status={task.state.status}>
        <TaskLayout
          status={task.state.status}
          title={<h2>{task.title}</h2>}
          description={
            task.description ? (
              <p className="task-description">{task.description}</p>
            ) : null
          }
          criteria={
            <ol className="criteria">
              {task.criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
          }
          owner={<MemberChip member={task.state.owner} data={data} />}
          reviewer={<MemberChip member={task.state.reviewer} data={data} />}
          acceptor={<MemberChip member={acceptor} data={data} />}
          topic={topic?.title ?? null}
          decision={
            <TaskDecision
              task={task}
              data={data}
              path={path}
              onDone={onDone}
              onDecided={onDecided}
            />
          }
        >
          {/* Agent wake-ups matter only while the task is with an agent. */}
          {withAgents(task.state.status) &&
            taskDeliveries(data, task.id).length > 0 && (
              <ul className="deliveries" aria-label="Agent responses">
                {taskDeliveries(data, task.id).map((d) => (
                  <DeliveryLine
                    key={d.id}
                    delivery={d}
                    data={data}
                    channelId={task.channelId}
                    openAgent={openAgent}
                    onDone={onDone}
                  />
                ))}
              </ul>
            )}
          <TaskHistory task={task} path={path} data={data} />
        </TaskLayout>
      </div>
    </Page>
  );
}
function TaskCard({
  task,
  data,
  onOpen,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  onOpen: () => void;
}) {
  const ask = humanAsk(task, data);
  return (
    <article
      className="task-card"
      ref={(el) => {
        // Lets a status change travel between columns as one element.
        el?.style.setProperty('view-transition-name', 'task-' + task.id);
      }}
      data-status={task.state.status}
      data-ask={ask ? 'true' : undefined}
      aria-label={task.title}
    >
      {/* A card says what the task is, what it asks of you, and who has
          it. A marker appears only when the column alone can't say it. */}
      {cardMarker(task.state.status) && (
        <span className="card-marker" data-status={task.state.status}>
          {cardMarker(task.state.status)}
        </span>
      )}
      <h3>
        <button type="button" className="card-link" onClick={onOpen}>
          {task.title}
        </button>
      </h3>
      {ask && <p className="ask-label">{ask}</p>}
      {(task.state.owner ?? task.state.reviewer) && (
        <footer>
          <span className="card-people">
            <MemberAvatar member={task.state.owner} data={data} />
            <MemberAvatar member={task.state.reviewer} data={data} />
          </span>
        </footer>
      )}
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
const KeptDraft = zod.object({
  draft: zod.object({
    id: zod.string(),
    title: zod.string(),
    description: zod.string(),
    topicId: zod.string().nullable(),
    sourceMessageId: zod.string().nullable(),
    from: zod.string().nullable(),
  }),
  fields: zod.record(zod.string(), zod.string()).default({}),
});
/** The new task being written in this tab, if any, with what was typed. */
export function keptDraft() {
  const parsed = KeptDraft.safeParse(kept('new-task'));
  return parsed.success ? parsed.data : null;
}
/** Keeps a new task and what was typed into it, until created or dropped. */
export function keepDraft(
  draft: TaskDraft | null,
  fields?: Record<string, string>,
) {
  if (draft === null) {
    keep('new-task', null);
    return;
  }
  const before = keptDraft();
  keep('new-task', {
    draft,
    fields: fields ?? (before?.draft.id === draft.id ? before.fields : {}),
  });
}
/** One line of Markdown as plain words: no markers, links as their text. */
export function plainLine(line: string) {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2')
    .trim();
}
/** A new task with nothing typed yet, in the topic it was started from. */
export const blankDraft = (topicId: string | null): TaskDraft => ({
  id: 'new-' + String(Date.now()),
  title: '',
  description: '',
  topicId,
  sourceMessageId: null,
  from: null,
});
export function draftFromMessage(
  message: z.infer<typeof Message>,
  data: WorkspaceSnapshot,
): TaskDraft {
  // The answer only (no provenance footer), and a title in plain words.
  const body = message.body.replace(LEGACY_FOOTER, '').trim();
  const firstLine =
    body
      .split('\n')
      .map(plainLine)
      .find((line) => line !== '') ?? '';
  return {
    id: message.id,
    title: firstLine.slice(0, 160),
    description: body.slice(0, 4000),
    topicId: message.topicId,
    sourceMessageId: message.id,
    from: memberName(message.author, data),
  };
}
/**
 * Five stages side by side and nothing else: no title (the tab says it), no
 * counts (the cards do), no boxes. A new task starts as the last card of
 * Proposed; what needs you is gathered in the Inbox.
 */
export function Board({
  data,
  next,
  openTask,
  onNewTask,
}: {
  data: WorkspaceSnapshot;
  next: () => void;
  openTask: (id: string) => void;
  onNewTask: () => void;
}) {
  const items = data.tasks.items;
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelled = items.filter((t) => t.state.status === 'cancelled');
  const byStage = new Map<StageId, Task[]>(stages.map((s) => [s.id, []]));
  for (const task of items)
    if (showCancelled || task.state.status !== 'cancelled')
      byStage.get(stageOf(task.state.status))?.push(task);
  const firstAsk = stages.find((s) =>
    byStage.get(s.id)?.some((t) => humanAsk(t, data)),
  );
  const [column, setColumn] = useState<StageId>(firstAsk?.id ?? 'proposed');
  return (
    <section aria-label="Task board">
      {/* A phone shows one stage at a time. */}
      <div className="column-switcher" role="group" aria-label="Stages">
        {stages.map((s) => (
          <button
            key={s.id}
            type="button"
            data-status={s.tone}
            aria-pressed={column === s.id}
            onClick={() => {
              setColumn(s.id);
            }}
          >
            {s.label}
            <span className="count">{byStage.get(s.id)?.length ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="board">
        {stages.map((s) => {
          const tasks = byStage.get(s.id) ?? [];
          return (
            <section
              key={s.id}
              className="board-column"
              data-status={s.tone}
              data-current={column === s.id ? 'true' : undefined}
              aria-label={s.label}
            >
              <h3 className="column-heading">
                <span className="dot" aria-hidden="true" />
                {s.label}
              </h3>
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  data={data}
                  onOpen={() => {
                    openTask(task.id);
                  }}
                />
              ))}
              {s.id === 'proposed' && (
                <button
                  type="button"
                  className="add-card"
                  aria-label="New task"
                  onClick={onNewTask}
                >
                  <PlusIcon />
                </button>
              )}
              {s.id === 'done' && cancelled.length > 0 && (
                <button
                  type="button"
                  className="quiet column-toggle"
                  aria-pressed={showCancelled}
                  onClick={() => {
                    setShowCancelled((v) => !v);
                  }}
                >
                  {showCancelled ? 'Hide cancelled' : 'Show cancelled'}
                </button>
              )}
            </section>
          );
        })}
      </div>
      {data.tasks.nextCursor && (
        <button className="quiet page-control" onClick={next}>
          Next tasks page
        </button>
      )}
    </section>
  );
}
