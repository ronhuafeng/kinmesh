import type { Task } from '../../src/domain/tasks.js';
import { TaskCommand } from '../../src/domain/tasks.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ActionForm } from '../shared/action-form.js';
import { Field } from '../shared/field.js';
import { composing } from '../shared/keys.js';
import { unchanged, editOf } from './model.js';
import { TaskLayout } from './task-layout.js';
import { CriteriaInput } from './criteria-input.js';
import { DueAndPriority } from './due-and-priority.js';
import { MemberChip } from './member-chip.js';
import { PersonPicker } from './person-picker.js';

/**
 * A task's acceptor says again what is asked, on the page it was created
 * on: its places filled in and editable. 保存 keeps it; 取消 or Esc leaves
 * it as it was, and saving what is unchanged only closes the form.
 */
export function TaskEdit({
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
