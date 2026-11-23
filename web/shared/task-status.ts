export type Status = Task['state']['status'];

import type { Task } from '../../src/domain/tasks.js';
import { memberKey } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

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
export type StageId = 'proposed' | 'working' | 'review' | 'sign-off' | 'done';
export const stages: readonly {
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
export function stageOf(status: Status): StageId {
  return stages.find((s) => s.statuses.includes(status))?.id ?? 'proposed';
}
/** The one exception a card states in words; the column says the rest. */
export function cardMarker(status: Status) {
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
