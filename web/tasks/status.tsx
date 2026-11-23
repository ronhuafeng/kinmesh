import {
  type Status,
  statusLabel,
  stages,
  stageOf,
} from '../shared/task-status.js';

export function StatusChip({ status }: { status: Status }) {
  return (
    <span className="status-chip" data-status={status}>
      {statusLabel(status)}
    </span>
  );
}
export function Lifecycle({ status }: { status: Status }) {
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
