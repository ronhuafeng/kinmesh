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
  TaskDue,
  TaskPriority,
  TaskResult,
} from '../src/domain/tasks.js';
import { Task } from '../src/domain/tasks.js';
import { Member, memberKey, pageOf } from '../src/domain/communication.js';
import type { Message } from '../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { threadLink } from '../src/workspace/links.js';
import { api, everyPage, Offline, value } from './api.js';
import { ActionForm, Field, Notice, SubmitGroup } from './forms.js';
import { DeliveryLine, taskDeliveries } from './deliveries.js';
import { joinedAgents, memberName, otherPeople, someoneOf } from './names.js';
import type { Someone } from './names.js';
import { LEGACY_FOOTER } from './replies.js';
import { Avatar, Page, cjk, composing, shortTime } from './ui.js';
import { DueIcon, PlusIcon, PriorityIcon } from './icons.js';
import type { Status } from './ui.js';

/** A member chosen in a picker, written there as "kind:id". */
function memberFrom(value: string): Member | null {
  if (!value) return null;
  const [kind, id] = value.split(':');
  return Member.parse({ kind, id });
}
/** Today, as a due date says a day (YYYY-MM-DD), where you are. */
function today(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
/** Past its day and still open. */
function late(task: Task) {
  return (
    task.due !== null &&
    task.due < today() &&
    task.state.status !== 'accepted' &&
    task.state.status !== 'cancelled'
  );
}
/** A due day as people say it: "11月30日", with the year when not this one. */
function dueLabel(due: string) {
  const [y = 0, m = 1, d = 1] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('zh-CN', {
    ...(y === new Date().getFullYear() ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
  });
}
const priorityLabels = { high: '高', normal: '普通', low: '低' } as const;
const priorityRank = { high: 0, normal: 1, low: 2 } as const;
/**
 * A column's order: what matters most first, then what is due soonest,
 * then the newest.
 */
function byUrgency(a: Task, b: Task) {
  return (
    priorityRank[a.priority] - priorityRank[b.priority] ||
    (a.due ?? '9999').localeCompare(b.due ?? '9999')
  );
}
/**
 * A value beside the people that isn't someone: its glyph where their face
 * would be, so every value starts on one edge.
 */
function SideValue({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="side-value">
      <span className="side-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}
/** When it is due and how much it matters, chosen. */
function DueAndPriority({ due, priority }: Pick<Task, 'due' | 'priority'>) {
  return {
    due: (
      <SideValue icon={<DueIcon />}>
        <input
          type="date"
          name="due"
          aria-label="截止日期"
          className="side-input"
          defaultValue={due ?? ''}
        />
      </SideValue>
    ),
    priority: (
      <SideValue icon={<PriorityIcon />}>
        <select
          name="priority"
          aria-label="优先级"
          className="side-input"
          defaultValue={priority}
        >
          {TaskPriority.options.map((p) => (
            <option key={p} value={p}>
              {priorityLabels[p]}
            </option>
          ))}
        </select>
      </SideValue>
    ),
  };
}
/** What the signed-in human must decide or do next, if anything. */
export function humanAsk(task: Task, data: WorkspaceSnapshot): string | null {
  const me = memberKey({ kind: 'human', id: data.human.id });
  const { status, owner, reviewer } = task.state;
  if (status === 'awaiting-human' && task.acceptorHumanId === data.human.id)
    return '等你验收';
  if (status === 'review-requested' && memberKey(reviewer) === me)
    return '等你审核';
  if (status === 'rework-requested' && memberKey(owner) === me)
    return '等你修改';
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
    label: '待开始',
    tone: 'proposed',
    statuses: ['proposed'],
  },
  {
    id: 'working',
    label: '进行中',
    tone: 'in-progress',
    statuses: ['in-progress', 'rework-requested'],
  },
  {
    id: 'review',
    label: '审核中',
    tone: 'review-requested',
    statuses: ['review-requested'],
  },
  {
    id: 'sign-off',
    label: '待验收',
    tone: 'awaiting-human',
    statuses: ['awaiting-human'],
  },
  {
    id: 'done',
    label: '已完成',
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
    ? '已退回'
    : status === 'cancelled'
      ? '已取消'
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
    <ol className="lifecycle" aria-label="任务进度">
      {stages.map((stage, index) => (
        <li
          key={stage.id}
          // Behind the task is passed, not finished; where it is wears its
          // board column's colour.
          data-step={
            index < current ? 'past' : index === current ? 'current' : 'todo'
          }
          data-status={stage.tone}
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
  people = false,
}: {
  data: WorkspaceSnapshot;
  exclude?: Member | null;
  /** People only: who may decide on a task. */
  people?: boolean;
}) {
  const shown = (member: Member) =>
    exclude === null || memberKey(member) !== memberKey(exclude);
  return (
    <>
      {shown({ kind: 'human', id: data.human.id }) && (
        <option value={'human:' + data.human.id}>{data.human.name}</option>
      )}
      {otherPeople(data)
        .filter((person) => shown({ kind: 'human', id: person.id }))
        .map((person) => (
          <option value={'human:' + person.id} key={person.id}>
            {person.name}
          </option>
        ))}
      {joinedAgents(data)
        .filter((a) => !people && shown({ kind: 'agent', id: a.id }))
        .map((a) => (
          <option value={'agent:' + a.id} key={a.id}>
            {a.name}
          </option>
        ))}
    </>
  );
}
function MemberSelect({
  id,
  name,
  data,
  required = false,
  empty = '未分配',
  exclude = null,
}: {
  /** Supplied by the wrapping Field, so its label names this select. */
  id?: string;
  name: string;
  data: WorkspaceSnapshot;
  required?: boolean;
  empty?: string;
  exclude?: Member | null;
}) {
  return (
    <select id={id} name={name} required={required} defaultValue="">
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
  '：“' + (note.length > 120 ? note.slice(0, 117) + '…' : note) + '”';
/** One line of task history as a person would say it. */
export function historySentence(
  e: z.infer<typeof TaskEvent>,
  data: WorkspaceSnapshot,
): string {
  return cjk(said(e, data));
}
function said(e: z.infer<typeof TaskEvent>, data: WorkspaceSnapshot): string {
  // Everyone, you included, is their name: the record reads the same to all.
  const who = memberName(e.author, data);
  const name = (m: Member) => memberName(m, data);
  const c = e.command;
  switch (c.type) {
    case 'create':
      return `${who} 创建了任务`;
    case 'claim':
      return `${who} 认领了任务`;
    case 'progress':
      return `${who} 发布了进展${quote(c.note)}`;
    case 'handoff': {
      const self =
        e.author.kind === c.recipient.kind &&
        (e.author.kind === 'human' ? e.author.humanId : e.author.agentId) ===
          c.recipient.id;
      return c.mode === 'review'
        ? `${who} 请 ${name(c.recipient)} 审核${quote(c.note)}`
        : self
          ? `${who} 接手了工作${quote(c.note)}`
          : `${who} 把工作交给了 ${name(c.recipient)}${quote(c.note)}`;
    }
    case 'request-review':
      return `${who} 请 ${name(c.reviewer)} 审核${quote(c.note)}`;
    case 'review':
      return c.decision === 'approve'
        ? `${who} 审核通过${quote(c.note)}`
        : `${who} 要求修改${quote(c.note)}`;
    case 'accept':
      return `${who} 验收通过${quote(c.note)}`;
    case 'rework':
      return `${who} 退回了任务${quote(c.note)}`;
    case 'cancel':
      return `${who} 取消了任务${quote(c.note)}`;
    case 'link-execution':
      return `${who} 关联了一次 T3 运行`;
    case 'edit': {
      const before = e.before;
      const changed = before
        ? [
            before.title !== c.title && '标题',
            before.description !== c.description && '描述',
            before.criteria.join('\n') !== c.criteria.join('\n') && '完成标准',
            (before.state.reviewer === null
              ? ''
              : memberKey(before.state.reviewer)) !==
              (c.reviewer === null ? '' : memberKey(c.reviewer)) && '审核人',
            before.due !== c.due && '截止日期',
            before.priority !== c.priority && '优先级',
          ].filter((v): v is string => v !== false)
        : [];
      return `${who} 修改了${changed.length > 0 ? changed.join('、') : '任务'}`;
    }
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
  const [failing, setFailing] = useState(false);
  // Read again whenever the task moves on; a failed read retries by itself,
  // a little later each time, and says so only once it keeps failing.
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number) => {
      void Promise.all([
        everyPage(path + '/history', TaskEvent, controller.signal),
        everyPage(path + '/executions', TaskExecution, controller.signal),
      ])
        .then(([events, refs]) => {
          setHistory(events);
          setLinks(refs);
          setFailing(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          if (attempt >= 2) setFailing(true);
          retry = setTimeout(
            () => {
              read(attempt + 1);
            },
            Math.min(1000 * 2 ** attempt, 30000),
          );
        });
    };
    read(0);
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [path, task.version]);
  const avatarOf = (author: z.infer<typeof TaskEvent>['author']) => (
    <MemberAvatar member={someoneOf(author)} data={data} />
  );
  const origin = data.nativeT3Origin;
  // Decisions and linked T3 runs, one timeline, oldest first. A linked run
  // is said once, by its link, which opens its thread on the team's T3.
  const lines = [
    ...history
      .filter((e) => e.command.type !== 'link-execution')
      .map((e) => ({
        key: e.id,
        at: e.createdAt,
        who: avatarOf(e.author),
        text: historySentence(e, data),
        href: null as string | null,
      })),
    ...links.map((link) => ({
      key: link.id,
      at: link.createdAt,
      who: avatarOf(link.author),
      text: cjk(`${memberName(link.author, data)} 关联了一次 T3 运行`),
      href: origin ? threadLink(origin, link.reference) : null,
    })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  return (
    <section className="task-history" aria-label="记录">
      <h3>记录</h3>
      {failing && <Notice>暂时读不到记录。</Notice>}
      <ol className="history">
        {lines.map((line) => (
          <li key={line.key}>
            <time dateTime={line.at}>{shortTime(line.at)}</time>
            {line.who}
            <span>
              {line.href ? (
                <a href={line.href} target="_blank" rel="noopener noreferrer">
                  {line.text}
                </a>
              ) : (
                line.text
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
  | 'edit'
  | 'cancel';
const intentLabels: Record<Intent, string> = {
  claim: '认领任务',
  progress: '发布进展',
  'request-review': '请求审核',
  approve: '审核通过',
  'review-rework': '要求修改',
  accept: '验收通过',
  handoff: '转交工作',
  rework: '退回修改',
  edit: '编辑任务',
  cancel: '取消任务',
};
/** What the person sees after the server confirms the decision. */
const intentDone: Record<Intent, string> = {
  claim: '已认领，任务现在由你进行。',
  progress: '进展已记录。',
  'request-review': '已请求审核。',
  approve: '审核已通过，等待验收。',
  'review-rework': '已要求修改，任务回到负责人手里。',
  accept: '已验收，备注已记录。',
  handoff: '工作已转交，审核重新开始。',
  rework: '已退回修改。',
  edit: '任务已修改。',
  cancel: '任务已取消。',
};
/** Work nobody has started is given to someone, not handed on. */
function labelOf(intent: Intent, task: Task) {
  return intent === 'handoff' && task.state.status === 'proposed'
    ? '指派负责人'
    : intentLabels[intent];
}
function doneOf(intent: Intent, task: Task) {
  return intent === 'handoff' && task.state.status === 'proposed'
    ? '已指派负责人。'
    : intentDone[intent];
}
/**
 * What you may do with a task, mirroring the server's rules so no button
 * leads to a certain 409/403: what waits on you leads the page; the rest is
 * one quiet row at its end, cancelling last.
 */
function taskActions(task: Task, data: WorkspaceSnapshot) {
  const human = { kind: 'human', id: data.human.id } satisfies Member;
  const { status, owner, reviewer } = task.state;
  const owns = owner !== null && memberKey(owner) === memberKey(human);
  const reviews = reviewer !== null && memberKey(reviewer) === memberKey(human);
  const final = task.acceptorHumanId === data.human.id;
  const done = status === 'accepted' || status === 'cancelled';
  const working = status === 'in-progress' || status === 'rework-requested';
  const lead: Intent[] = [];
  const rest: Intent[] = [];
  if (
    status === 'proposed' &&
    (reviewer === null || memberKey(reviewer) !== memberKey(human))
  )
    lead.push('claim');
  if (final && status === 'awaiting-human') lead.push('accept');
  if (reviews && status === 'review-requested')
    lead.push('approve', 'review-rework');
  // Work sent back to you waits on you; otherwise reporting is up to you.
  if (owns && working)
    (status === 'rework-requested' ? lead : rest).push('progress');
  if (owns && status === 'in-progress') rest.push('request-review');
  if ((final && !done) || (owns && working)) rest.push('handoff');
  if (final && !done && owner !== null) rest.push('rework');
  if (final && !done) rest.push('edit', 'cancel');
  return { lead, rest, done };
}
/**
 * One decision: who it goes to when it hands the task on, the note, and its
 * buttons. The note is always written by the human; claiming needs none.
 */
function DecisionForm({
  task,
  data,
  path,
  title,
  intents,
  held,
  onBack,
  onSettled,
  onDone,
  onDecided,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  title: string;
  intents: Intent[];
  /** Buttons wait for the new task version after a decision lands. */
  held: boolean;
  /** Puts back the row of actions this one was chosen from. */
  onBack?: () => void;
  onSettled: () => void;
  onDone: () => void;
  onDecided: (message: string) => void;
}) {
  const offline = useContext(Offline);
  const chosen = useRef<Intent | null>(null);
  const human = { kind: 'human', id: data.human.id } satisfies Member;
  const routed = intents.find(
    (intent) => intent === 'handoff' || intent === 'request-review',
  );
  // A recipient must differ from the current owner (work) or from you (review).
  const exclude =
    routed === 'handoff'
      ? (task.state.owner ?? task.state.reviewer)
      : routed === 'request-review'
        ? human
        : null;
  return (
    <ActionForm
      key={task.id}
      title={title}
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
        onSettled();
        if (chosen.current) onDecided(doneOf(chosen.current, task));
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
      {routed && (
        <Field label="接收人">
          <MemberSelect
            name="recipient"
            data={data}
            required
            empty="选择频道里的成员"
            exclude={exclude}
          />
        </Field>
      )}
      {intents.includes('cancel') && (
        <p className="decision-warning">
          取消会不经验收直接关闭任务，之后无法重新打开。
        </p>
      )}
      {intents.some((intent) => intent !== 'claim') && (
        <Field label="决定备注">
          <textarea
            name="note"
            className="decision-note"
            required
            maxLength={2000}
            rows={1}
            placeholder="写下备注"
            // Chosen from the row, the note is the next thing to write.
            autoFocus={onBack !== undefined && !routed}
          />
        </Field>
      )}
      <SubmitGroup className="decision-buttons" held={held}>
        {intents.map((intent, index) => (
          <button
            key={intent}
            type="submit"
            name="intent"
            value={intent}
            // The way forward is green; cancelling is the one red.
            className={
              intent === 'cancel'
                ? 'danger'
                : index > 0
                  ? 'secondary'
                  : undefined
            }
            formNoValidate={intent === 'claim'}
            onClick={() => {
              chosen.current = intent;
            }}
          >
            {labelOf(intent, task)}
          </button>
        ))}
        {onBack && (
          <button type="button" className="secondary" onClick={onBack}>
            返回
          </button>
        )}
      </SubmitGroup>
      {offline && (
        <p className="decision-help">工作区重新连上之前，操作暂停。</p>
      )}
    </ActionForm>
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
  const list = useRef<HTMLUListElement>(null);
  // A row added or removed changes what the form holds without typing: the
  // draft kept from each input hears of it too.
  const changed = useRef(false);
  useEffect(() => {
    if (changed.current) {
      changed.current = false;
      list.current?.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (focus.current === null) return;
    inputs.current[focus.current]?.focus();
    focus.current = null;
  }, [rows.length]);
  const placeholders = ['测试通过', '文档已更新'];
  return (
    <ul className="criteria-input" ref={list}>
      {rows.map((row, index) => (
        <li key={index}>
          <input
            ref={(el) => {
              inputs.current[index] = el;
            }}
            name="criteria"
            aria-label={
              index === 0 ? '完成标准' : `完成标准 ${String(index + 1)}`
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
              if (composing(e)) return;
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
                changed.current = true;
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
          aria-label="添加一条标准"
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
  people = false,
  exclude = null,
}: {
  name: string;
  label: string;
  data: WorkspaceSnapshot;
  initial: string;
  /** Only people, and always someone: who decides on a task. */
  people?: boolean;
  /** Someone who can't be chosen here, such as the owner as reviewer. */
  exclude?: Member | null;
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
        {!people && <option value="">选择…</option>}
        <MemberOptions data={data} people={people} exclude={exclude} />
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
    <Page
      label="新任务"
      onClose={onClose}
      className="task-page"
      tabLeadsBack
      bar={data.channel ? '# ' + data.channel.name : '新任务'}
    >
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
          title="新任务"
          path={channelPath + '/tasks'}
          onDone={() => {
            onNotify(draft.from ? '已从消息创建任务。' : '任务已创建。');
          }}
          onResult={(raw) => {
            const created = TaskResult.safeParse(raw);
            if (created.success) onCreated(created.data.task.id);
          }}
          build={(f) => {
            // You decide unless you ask someone else to.
            const chosen = memberFrom(value(f, 'acceptor'))?.id ?? null;
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
              acceptor: chosen === data.human.id ? null : chosen,
              due: value(f, 'due') || null,
              priority: value(f, 'priority') || 'normal',
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
                <p className="draft-source">来自 {draft.from} 的消息</p>
              ) : null
            }
            title={
              <Field label="任务标题">
                <input
                  name="title"
                  className="title-input"
                  required
                  maxLength={160}
                  placeholder="要做什么？"
                  defaultValue={typed.title ?? draft.title}
                  autoFocus
                />
              </Field>
            }
            description={
              <Field label="描述">
                <textarea
                  name="description"
                  className="description-input"
                  rows={3}
                  maxLength={4000}
                  placeholder="添加描述"
                  defaultValue={typed.description ?? draft.description}
                />
              </Field>
            }
            criteria={
              <CriteriaInput
                initial={(typed.criteria ?? '').split('\n').filter(Boolean)}
              />
            }
            {...DueAndPriority({
              due: TaskDue.catch(null).parse(typed.due),
              priority: TaskPriority.catch('normal').parse(typed.priority),
            })}
            owner={
              <PersonPicker
                name="owner"
                label="负责人"
                data={data}
                initial={typed.owner ?? ''}
              />
            }
            reviewer={
              <PersonPicker
                name="reviewer"
                label="审核人"
                data={data}
                initial={typed.reviewer ?? ''}
              />
            }
            acceptor={
              <PersonPicker
                name="acceptor"
                label="验收人"
                data={data}
                initial={typed.acceptor ?? 'human:' + data.human.id}
                people
              />
            }
            topic={topic?.title ?? null}
          >
            <button type="submit" className="create-task">
              创建任务
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
  due = null,
  priority = null,
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
  /** When it is due and how much it matters; a row only when said. */
  due?: ReactNode;
  priority?: ReactNode;
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
            <h3>完成标准</h3>
            {criteria}
          </section>
          {children}
        </div>
        <aside className="task-side" aria-label="成员">
          <dl className="people-list">
            <dt>负责人</dt>
            <dd>{owner}</dd>
            <dt>审核人</dt>
            <dd>{reviewer}</dd>
            <dt>验收人</dt>
            <dd>{acceptor}</dd>
            {due !== null && (
              <>
                <dt>截止</dt>
                <dd>{due}</dd>
              </>
            )}
            {priority !== null && (
              <>
                <dt>优先级</dt>
                <dd>{priority}</dd>
              </>
            )}
          </dl>
          {topic && <span className="topic-pill static">{topic}</span>}
        </aside>
      </div>
    </div>
  );
}
/**
 * The decision that waits on you, marked in orange, led by the latest note
 * that brought it here.
 */
function TaskDecision({
  task,
  data,
  path,
  intents,
  held,
  onSettled,
  onDone,
  onDecided,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  intents: Intent[];
  held: boolean;
  onSettled: () => void;
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
      <div className="decision-panel">
        <DecisionForm
          task={task}
          data={data}
          path={path}
          title={ask ? '等你决定' : labelOf(intents[0] ?? 'claim', task)}
          intents={intents}
          held={held}
          onSettled={onSettled}
          onDone={onDone}
          onDecided={onDecided}
        />
      </div>
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
  onReply,
  openAgent,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  onDone: () => void;
  onClose: () => void;
  onDecided: (message: string) => void;
  /** Opens an agent's reply in the conversation. */
  onReply: (messageId: string) => void;
  openAgent: (agentId: string) => void;
}) {
  const topic = task.topicId
    ? data.topics.items.find((t) => t.id === task.topicId)
    : undefined;
  const acceptor = { kind: 'human', id: task.acceptorHumanId } satisfies Member;
  const { lead, rest, done } = taskActions(task, data);
  // One of the row's actions, chosen: its note opens in place of the row.
  const [picked, setPicked] = useState<Intent | null>(null);
  // Edited, the task is the page it was created on, filled in.
  const [editing, setEditing] = useState(false);
  const chosen = picked !== null && rest.includes(picked) ? picked : null;
  // After a decision lands, buttons wait for the new task version so a second
  // click can never re-send against the old one.
  const [decidedAt, setDecidedAt] = useState<number | null>(null);
  const held = decidedAt === task.version;
  const settled = () => {
    setPicked(null);
    setDecidedAt(task.version);
  };
  const deliveries = withAgents(task.state.status)
    ? taskDeliveries(data, task.id)
    : [];
  const decision = { task, data, path, held, onDone, onDecided };
  if (editing && rest.includes('edit'))
    return (
      <Page
        label={task.title}
        onClose={onClose}
        className="task-page"
        tabLeadsBack
        bar={data.channel ? '# ' + data.channel.name : ''}
      >
        <TaskEdit
          task={task}
          data={data}
          path={path}
          topic={topic?.title ?? null}
          onClose={() => {
            setEditing(false);
          }}
          onDone={() => {
            setEditing(false);
            onDecided(intentDone.edit);
            onDone();
          }}
        />
      </Page>
    );
  return (
    <Page
      label={task.title}
      onClose={onClose}
      className="task-page"
      tabLeadsBack
      // The title is the page's own first line; the bar says where it is.
      bar={data.channel ? '# ' + data.channel.name : ''}
    >
      <div className="page-body" data-status={task.state.status}>
        <TaskLayout
          status={task.state.status}
          title={<h2>{task.title}</h2>}
          description={
            // A task made from a message is often titled by all of it.
            task.description &&
            task.description.trim() !== task.title.trim() ? (
              <p className="task-description">{task.description}</p>
            ) : null
          }
          criteria={
            <ol className="criteria">
              {task.criteria.map((c, index) => (
                <li key={index}>{c}</li>
              ))}
            </ol>
          }
          owner={<MemberChip member={task.state.owner} data={data} />}
          reviewer={<MemberChip member={task.state.reviewer} data={data} />}
          acceptor={<MemberChip member={acceptor} data={data} />}
          due={
            task.due && (
              <SideValue icon={<DueIcon />}>
                <time
                  className="task-due"
                  dateTime={task.due}
                  data-late={late(task) ? 'true' : undefined}
                >
                  {dueLabel(task.due)}
                </time>
              </SideValue>
            )
          }
          priority={
            task.priority === 'normal' ? null : (
              <SideValue icon={<PriorityIcon />}>
                <span data-priority={task.priority}>
                  {priorityLabels[task.priority]}
                </span>
              </SideValue>
            )
          }
          topic={topic?.title ?? null}
          decision={
            <>
              {/* What waits on you leads; then where the task is now. */}
              {lead.length > 0 && (
                <TaskDecision
                  {...decision}
                  intents={lead}
                  onSettled={settled}
                />
              )}
              {deliveries.length > 0 && (
                <ul className="deliveries" aria-label="智能体响应">
                  {deliveries.map((d) => (
                    <DeliveryLine
                      key={d.id}
                      delivery={d}
                      data={data}
                      channelId={task.channelId}
                      onReply={onReply}
                      openAgent={openAgent}
                      onDone={onDone}
                    />
                  ))}
                </ul>
              )}
              {done && <p className="muted decision-none">任务已关闭。</p>}
            </>
          }
        >
          <TaskHistory task={task} path={path} data={data} />
          {chosen ? (
            <div className="task-actions">
              <DecisionForm
                {...decision}
                title={labelOf(chosen, task)}
                intents={[chosen]}
                onBack={() => {
                  setPicked(null);
                }}
                onSettled={settled}
              />
            </div>
          ) : (
            rest.length > 0 && (
              <div className="task-actions route-buttons">
                {rest.map((intent) => (
                  <button
                    key={intent}
                    type="button"
                    className={
                      intent === 'cancel' ? 'quiet subtle-danger' : 'quiet'
                    }
                    onClick={() => {
                      if (intent === 'edit') setEditing(true);
                      else setPicked(intent);
                    }}
                  >
                    {labelOf(intent, task)}
                  </button>
                ))}
              </div>
            )
          )}
        </TaskLayout>
      </div>
    </Page>
  );
}
/** What an edit would make of the task, as the form holds it. */
function editOf(f: FormData, task: Task) {
  const reviewer = f.get('reviewer');
  return {
    title: value(f, 'title').trim(),
    description: value(f, 'description').trim(),
    criteria: f
      .getAll('criteria')
      .map((c) => (typeof c === 'string' ? c.trim() : ''))
      .filter(Boolean),
    // Settled once review is asked for, it is shown, not chosen.
    reviewer:
      reviewer === null
        ? task.state.reviewer
        : memberFrom(typeof reviewer === 'string' ? reviewer : ''),
    due: value(f, 'due') || null,
    priority: TaskPriority.parse(value(f, 'priority') || 'normal'),
  };
}
function unchanged(edit: ReturnType<typeof editOf>, task: Task) {
  const key = (m: Member | null) => (m === null ? '' : memberKey(m));
  return (
    edit.title === task.title &&
    edit.description === task.description &&
    edit.criteria.join('\n') === task.criteria.join('\n') &&
    key(edit.reviewer) === key(task.state.reviewer) &&
    edit.due === task.due &&
    edit.priority === task.priority
  );
}
/**
 * A task's acceptor says again what is asked, on the page it was created
 * on: its places filled in and editable. 保存 keeps it; 取消 or Esc leaves
 * it as it was, and saving what is unchanged only closes the form.
 */
function TaskEdit({
  task,
  data,
  path,
  topic,
  onClose,
  onDone,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  topic: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { status, owner, reviewer } = task.state;
  const settled = status === 'review-requested' || status === 'awaiting-human';
  return (
    <div
      className="page-body"
      data-status={status}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || composing(e)) return;
        // Esc leaves the edit, not the task.
        e.preventDefault();
        onClose();
      }}
      onSubmitCapture={(e) => {
        if (!(e.target instanceof HTMLFormElement)) return;
        if (!unchanged(editOf(new FormData(e.target), task), task)) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <ActionForm
        key={task.id}
        title="编辑任务"
        path={path + '/edit'}
        onDone={onDone}
        build={(f) => {
          const command = TaskCommand.parse({
            operationKey: crypto.randomUUID(),
            expectedVersion: task.version,
            type: 'edit',
            ...editOf(f, task),
          });
          return Object.fromEntries(
            Object.entries(command).filter(
              ([key]) => key !== 'type' && key !== 'operationKey',
            ),
          );
        }}
      >
        <TaskLayout
          status={status}
          title={
            <Field label="任务标题">
              <input
                name="title"
                className="title-input"
                required
                maxLength={160}
                defaultValue={task.title}
                autoFocus
              />
            </Field>
          }
          description={
            <Field label="描述">
              <textarea
                name="description"
                className="description-input"
                rows={3}
                maxLength={4000}
                placeholder="添加描述"
                defaultValue={task.description}
              />
            </Field>
          }
          criteria={<CriteriaInput initial={task.criteria} />}
          {...DueAndPriority(task)}
          owner={<MemberChip member={owner} data={data} />}
          reviewer={
            settled ? (
              <MemberChip member={reviewer} data={data} />
            ) : (
              <PersonPicker
                name="reviewer"
                label="审核人"
                data={data}
                initial={reviewer ? reviewer.kind + ':' + reviewer.id : ''}
                exclude={owner}
              />
            )
          }
          acceptor={
            <MemberChip
              member={{ kind: 'human', id: task.acceptorHumanId }}
              data={data}
            />
          }
          topic={topic}
        >
          <div className="task-edit-buttons">
            <button type="submit">保存</button>
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
          </div>
        </TaskLayout>
      </ActionForm>
    </div>
  );
}
function TaskCard({
  task,
  data,
  open,
  onOpen,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  /** Its page is open beside the board. */
  open: boolean;
  onOpen: () => void;
}) {
  const ask = humanAsk(task, data);
  return (
    <article
      data-open={open ? 'true' : undefined}
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
          {task.priority === 'high' && (
            <span className="card-priority" title="高优先级">
              <PriorityIcon />
              <span className="visually-hidden">高优先级：</span>
            </span>
          )}
          {task.title}
        </button>
      </h3>
      {(ask ?? task.due ?? task.state.owner ?? task.state.reviewer) && (
        <footer>
          {ask && <p className="ask-label">{ask}</p>}
          {task.due && (
            <time
              className="card-due"
              dateTime={task.due}
              data-late={late(task) ? 'true' : undefined}
            >
              {dueLabel(task.due)}
            </time>
          )}
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
 * counts (the cards do). A new task starts as the last card of
 * Proposed; what needs you is gathered in the Inbox.
 */
/** Whose tasks and which topic's the board shows; the address keeps it. */
export interface BoardFilter {
  /** 'all', 'mine', or one member's key (`agent:<id>`, `human:<id>`). */
  who: string;
  /** '' for every topic, else one topic's ID. */
  topic: string;
}
export const ALL_TASKS: BoardFilter = { who: 'all', topic: '' };
/** Whether a task is yours: you own it, review it, or decide on it. */
function yours(task: Task, me: string) {
  const owner = task.state.owner;
  const reviewer = 'reviewer' in task.state ? task.state.reviewer : null;
  return (
    task.acceptorHumanId === me ||
    (owner?.kind === 'human' && owner.id === me) ||
    (reviewer?.kind === 'human' && reviewer.id === me)
  );
}
/**
 * The channel's tasks older than the board's newest (`data.tasks`), read a
 * page at a time from the cursor each page gives.
 */
function useOlderTasks(path: string, first: string | null) {
  const [state, setState] = useState<{
    path: string;
    items: Task[];
    cursor: string | null | undefined;
  }>({ path, items: [], cursor: undefined });
  const current =
    state.path === path
      ? state
      : { path, items: [] as Task[], cursor: undefined };
  const cursor = current.cursor === undefined ? first : current.cursor;
  const [busy, setBusy] = useState(false);
  const load = () => {
    if (cursor === null || busy) return;
    setBusy(true);
    void api(path + '?limit=100&cursor=' + encodeURIComponent(cursor))
      .then((raw) => {
        const page = pageOf(Task).parse(raw);
        setState((old) => {
          const kept = old.path === path ? old.items : [];
          const ids = new Set(kept.map((t) => t.id));
          return {
            path,
            items: [...kept, ...page.items.filter((t) => !ids.has(t.id))],
            cursor: page.nextCursor,
          };
        });
      })
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  };
  return { items: current.items, more: cursor !== null, load, busy };
}
export function Board({
  data,
  openTask,
  onNewTask,
  openId = null,
  filter = ALL_TASKS,
  onFilter = () => undefined,
}: {
  data: WorkspaceSnapshot;
  openTask: (id: string) => void;
  onNewTask: () => void;
  /** The task whose page is open, beside the board on a wide tablet. */
  openId?: string | null;
  filter?: BoardFilter;
  onFilter?: (filter: BoardFilter) => void;
}) {
  const older = useOlderTasks(
    `/api/teams/${data.team.id}/channels/${data.channel?.id ?? ''}/tasks`,
    data.tasks.nextCursor,
  );
  const newest = new Set(data.tasks.items.map((t) => t.id));
  const every = [
    ...data.tasks.items,
    ...older.items.filter((t) => !newest.has(t.id)),
  ];
  // Who and which topic the board can be narrowed to: only those it holds.
  const owners = new Map<string, string>();
  for (const t of every)
    if (t.state.owner)
      owners.set(memberKey(t.state.owner), memberName(t.state.owner, data));
  const topics = [
    ...new Set(every.flatMap((t) => (t.topicId ? [t.topicId] : []))),
  ].map((id) => ({
    id,
    title: data.topics.items.find((topic) => topic.id === id)?.title ?? '话题',
  }));
  // A topic of another channel (kept from before) narrows nothing here.
  const topic = topics.some((t) => t.id === filter.topic) ? filter.topic : '';
  const items = every.filter(
    (t) =>
      (filter.who === 'all' ||
        (filter.who === 'mine'
          ? yours(t, data.human.id)
          : t.state.owner !== null &&
            memberKey(t.state.owner) === filter.who)) &&
      (topic === '' || t.topicId === topic),
  );
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelled = items.filter((t) => t.state.status === 'cancelled');
  const byStage = new Map<StageId, Task[]>(stages.map((s) => [s.id, []]));
  for (const task of items)
    if (showCancelled || task.state.status !== 'cancelled')
      byStage.get(stageOf(task.state.status))?.push(task);
  // Open work by urgency (ties stay newest first); what is done, newest first.
  for (const [stage, list] of byStage)
    if (stage !== 'done') list.sort(byUrgency);
  const firstAsk = stages.find((s) =>
    byStage.get(s.id)?.some((t) => humanAsk(t, data)),
  );
  const [column, setColumn] = useState<StageId>(firstAsk?.id ?? 'proposed');
  // One stage at a time shows the stage of the task that is open.
  const openStage = items.find((t) => t.id === openId)?.state.status;
  useEffect(() => {
    if (openStage) setColumn(stageOf(openStage));
  }, [openStage]);
  return (
    <section aria-label="任务看板">
      <div className="board-filter" role="group" aria-label="筛选任务">
        <div className="segmented" role="group" aria-label="谁的任务">
          {(
            [
              ['all', '全部'],
              ['mine', '我的'],
            ] as const
          ).map(([who, label]) => (
            <button
              key={who}
              type="button"
              aria-pressed={filter.who === who}
              onClick={() => {
                onFilter({ ...filter, who });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {owners.size > 1 && (
          <select
            aria-label="负责人"
            value={owners.has(filter.who) ? filter.who : ''}
            onChange={(event) => {
              onFilter({ ...filter, who: event.currentTarget.value || 'all' });
            }}
          >
            <option value="">所有负责人</option>
            {[...owners].map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        )}
        {topics.length > 0 && (
          <select
            aria-label="话题"
            value={topic}
            onChange={(event) => {
              onFilter({ ...filter, topic: event.currentTarget.value });
            }}
          >
            <option value="">所有话题</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* A narrow board shows one stage at a time. */}
      <div className="column-switcher" role="group" aria-label="阶段">
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
                  open={task.id === openId}
                  onOpen={() => {
                    openTask(task.id);
                  }}
                />
              ))}
              {s.id === 'proposed' && (
                <button
                  type="button"
                  className="add-card"
                  aria-label="新任务"
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
                  {showCancelled ? '隐藏已取消' : '显示已取消'}
                </button>
              )}
              {/* Finished work goes back as far as the channel does. */}
              {s.id === 'done' && older.more && (
                <button
                  type="button"
                  className="quiet column-toggle"
                  disabled={older.busy}
                  onClick={older.load}
                >
                  更早的任务
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
