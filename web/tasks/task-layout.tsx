import type { ReactNode } from 'react';
import type { Status } from '../shared/task-status.js';
import { StatusChip } from './status-chip.js';
import { Lifecycle } from './lifecycle.js';

/**
 * One layout for a task, new or existing: progress across the top, the
 * title and description, then what "done" means and what happens next on
 * the left, and the people on the right.
 */
export function TaskLayout({
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
