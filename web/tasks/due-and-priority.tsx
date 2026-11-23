import type { ReactNode } from 'react';
import { type Task, TaskPriority } from '../../src/domain/tasks.js';
import { DueIcon, PriorityIcon } from '../shared/icons.js';
import { priorityLabels } from './model.js';

/**
 * A value beside the people that isn't someone: its glyph where their face
 * would be, so every value starts on one edge.
 */
export function SideValue({
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
export function DueAndPriority({
  due,
  priority,
}: Pick<Task, 'due' | 'priority'>) {
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
