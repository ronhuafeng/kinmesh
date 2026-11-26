import type { Task } from '../../src/domain/tasks.js';
import { TaskPriority } from '../../src/domain/tasks.js';
import { Member, memberKey } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { value } from '../shared/api.js';
import type { Status } from '../shared/task-status.js';
import {
  pullRequestStale,
  type TaskPullRequestView,
} from '../../src/domain/pull-requests.js';

/** A member chosen in a picker, written there as "kind:id". */
export function memberFrom(value: string): Member | null {
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
export function late(task: Task) {
  return (
    task.due !== null &&
    task.due < today() &&
    task.state.status !== 'accepted' &&
    task.state.status !== 'cancelled'
  );
}
/** A due day as people say it: "11月30日", with the year when not this one. */
export function dueLabel(due: string) {
  const [y = 0, m = 1, d = 1] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('zh-CN', {
    ...(y === new Date().getFullYear() ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
  });
}
export const priorityLabels = {
  high: '高',
  normal: '普通',
  low: '低',
} as const;
const priorityRank = { high: 0, normal: 1, low: 2 } as const;
/**
 * An open column's order: what matters most first, then what is due
 * soonest, then the newest.
 */
export function byUrgency(a: Task, b: Task) {
  return (
    priorityRank[a.priority] - priorityRank[b.priority] ||
    (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
    b.position - a.position
  );
}
/**
 * Finished work, the most recently finished first: a finished task never
 * changes again, so its last change is when it finished.
 */
export function byFinish(a: Task, b: Task) {
  return b.updatedAt.localeCompare(a.updatedAt) || b.position - a.position;
}
export type Intent =
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
export const intentDone: Record<Intent, string> = {
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
export function labelOf(intent: Intent, task: Task) {
  return intent === 'handoff' && task.state.status === 'proposed'
    ? '指派负责人'
    : intentLabels[intent];
}
export function doneOf(intent: Intent, task: Task) {
  return intent === 'handoff' && task.state.status === 'proposed'
    ? '已指派负责人。'
    : intentDone[intent];
}
/**
 * What you may do with a task, mirroring the server's rules so no button
 * leads to a certain 409/403: what waits on you leads the page; the rest is
 * one quiet row at its end, cancelling last.
 */
export function taskActions(task: Task, data: WorkspaceSnapshot) {
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
export const withAgents = (status: Status) =>
  status === 'in-progress' ||
  status === 'review-requested' ||
  status === 'rework-requested';
/** What an edit would make of the task, as the form holds it. */
export function editOf(f: FormData, task: Task) {
  const reviewer = f.get('reviewer');
  return {
    title: value(f, 'title').trim(),
    description: value(f, 'description').trim(),
    // Settled once review is asked for, criteria and reviewer are shown,
    // not written or chosen.
    criteria: f.has('criteria')
      ? f
          .getAll('criteria')
          .map((c) => (typeof c === 'string' ? c.trim() : ''))
          .filter(Boolean)
      : task.criteria,
    reviewer:
      reviewer === null
        ? task.state.reviewer
        : memberFrom(typeof reviewer === 'string' ? reviewer : ''),
    due: value(f, 'due') || null,
    priority: TaskPriority.parse(value(f, 'priority') || 'normal'),
  };
}
export function unchanged(edit: ReturnType<typeof editOf>, task: Task) {
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
/** Whether a task is yours: you own it, review it, or decide on it. */
export function yours(task: Task, me: string) {
  const owner = task.state.owner;
  const reviewer = 'reviewer' in task.state ? task.state.reviewer : null;
  return (
    task.acceptorHumanId === me ||
    (owner?.kind === 'human' && owner.id === me) ||
    (reviewer?.kind === 'human' && reviewer.id === me)
  );
}
/**
 * What GitHub last said about a linked PR, in the person's words: its state
 * (with its age once stale) and its head commit's checks; null where GitHub
 * has not said. `failing` when its checks failed.
 */
export function pullRequestWords(view: TaskPullRequestView, now: number) {
  const o = view.observation;
  if (o === null) return { state: null, checks: null, failing: false };
  if (o.kind === 'unavailable')
    return {
      state:
        o.reason === 'not-found'
          ? 'GitHub 上找不到，或没有权限查看'
          : o.reason === 'forbidden'
            ? 'GitHub 拒绝了 Kinmesh 的读取权限'
            : '暂时读不到 GitHub',
      checks: null,
      failing: false,
    };
  const state =
    o.state === 'merged'
      ? '已合并'
      : o.state === 'closed'
        ? '已关闭'
        : o.draft
          ? '草稿'
          : '进行中';
  const c = o.checks;
  const checks =
    c === null
      ? null
      : c.kind === 'unavailable'
        ? c.reason === 'forbidden'
          ? '读不到 CI：没有权限'
          : '暂时读不到 CI'
        : {
            passing: 'CI 通过',
            failing: 'CI 失败',
            pending: 'CI 进行中',
            none: '没有 CI',
          }[c.state];
  return {
    state: pullRequestStale(o, now) ? `${state}，可能已过时` : state,
    checks,
    failing: c?.kind === 'observed' && c.state === 'failing',
  };
}
