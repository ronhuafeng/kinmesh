import {
  TaskCreate,
  TaskDue,
  TaskPriority,
  TaskResult,
} from '../../src/domain/tasks.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { value } from '../shared/api.js';
import { ActionForm } from '../shared/forms.js';
import { Field } from '../shared/forms.js';
import { Page } from '../shared/page.js';
import { topicTitle } from '../shared/names.js';
import { type TaskDraft, keptDraft, keepDraft } from '../shared/task-draft.js';
import { memberFrom } from './model.js';
import { TaskLayout } from './task-layout.js';
import { CriteriaInput } from './criteria-input.js';
import { DueAndPriority } from './due-and-priority.js';
import { PersonPicker } from './members.js';

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
  const topic = topicTitle(data, draft.topicId);
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
            topic={topic}
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
