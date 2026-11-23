import type { Status } from '../shared/task-status.js';
import { statusLabel } from '../shared/task-status.js';

export function StatusChip({ status }: { status: Status }) {
  return (
    <span className="status-chip" data-status={status}>
      {statusLabel(status)}
    </span>
  );
}
