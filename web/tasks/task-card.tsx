import type { Task } from '../../src/domain/tasks.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { PriorityIcon } from '../shared/icons.js';
import { humanAsk, cardMarker } from '../shared/task-status.js';
import { late, dueLabel } from './model.js';
import { MemberAvatar } from './member-avatar.js';

export function TaskCard({
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
