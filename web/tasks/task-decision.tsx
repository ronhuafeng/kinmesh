import type { Task } from '../../src/domain/tasks.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { type Intent, labelOf } from './model.js';
import { humanAsk } from '../shared/task-status.js';
import { DecisionForm } from './decision-form.js';

/**
 * The decision that waits on you, marked in orange, led by the latest note
 * that brought it here.
 */
export function TaskDecision({
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
