import { useContext, useRef } from 'react';
import { type Task, TaskCommand } from '../../src/domain/tasks.js';
import type { Member } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Offline, value } from '../shared/api.js';
import { ActionForm, Field, SubmitGroup } from '../shared/forms.js';
import { type Intent, doneOf, memberFrom, labelOf } from './model.js';
import { MemberSelect } from './members.js';
import { humanAsk } from '../shared/task-status.js';

/**
 * One decision: who it goes to when it hands the task on, the note, and its
 * buttons. The note is always written by the human; claiming needs none.
 */
export function DecisionForm({
  task,
  data,
  path,
  title,
  intents,
  held,
  onBack,
  onSettled,
  onDone,
  onDecided,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  title: string;
  intents: Intent[];
  /** Buttons wait for the new task version after a decision lands. */
  held: boolean;
  /** Puts back the row of actions this one was chosen from. */
  onBack?: () => void;
  onSettled: () => void;
  onDone: () => void;
  onDecided: (message: string) => void;
}) {
  const offline = useContext(Offline);
  const chosen = useRef<Intent | null>(null);
  const human = { kind: 'human', id: data.human.id } satisfies Member;
  const routed = intents.find(
    (intent) => intent === 'handoff' || intent === 'request-review',
  );
  // A recipient must differ from the current owner (work) or from you (review).
  const exclude =
    routed === 'handoff'
      ? (task.state.owner ?? task.state.reviewer)
      : routed === 'request-review'
        ? human
        : null;
  return (
    <ActionForm
      key={task.id}
      title={title}
      path={(f) => {
        const intent = value(f, 'intent');
        return (
          path +
          '/' +
          (intent === 'approve' || intent === 'review-rework'
            ? 'review'
            : intent)
        );
      }}
      onDone={() => {
        onSettled();
        if (chosen.current) onDecided(doneOf(chosen.current, task));
        onDone();
      }}
      build={(f) => {
        const intent = value(f, 'intent');
        const base = {
          operationKey: crypto.randomUUID(),
          expectedVersion: task.version,
        };
        const command = TaskCommand.parse(
          intent === 'claim'
            ? { ...base, type: 'claim' }
            : intent === 'request-review'
              ? {
                  ...base,
                  type: intent,
                  note: value(f, 'note'),
                  reviewer: memberFrom(value(f, 'recipient')),
                }
              : intent === 'handoff'
                ? {
                    ...base,
                    type: intent,
                    note: value(f, 'note'),
                    mode: 'work',
                    recipient: memberFrom(value(f, 'recipient')),
                  }
                : intent === 'approve' || intent === 'review-rework'
                  ? {
                      ...base,
                      type: 'review',
                      decision: intent === 'approve' ? 'approve' : 'rework',
                      note: value(f, 'note'),
                    }
                  : { ...base, type: intent, note: value(f, 'note') },
        );
        return Object.fromEntries(
          Object.entries(command).filter(
            ([key]) => key !== 'type' && key !== 'operationKey',
          ),
        );
      }}
    >
      {routed && (
        <Field label="接收人">
          <MemberSelect
            name="recipient"
            data={data}
            required
            empty="选择频道里的成员"
            exclude={exclude}
          />
        </Field>
      )}
      {intents.includes('cancel') && (
        <p className="decision-warning">
          取消会不经验收直接关闭任务，之后无法重新打开。
        </p>
      )}
      {intents.some((intent) => intent !== 'claim') && (
        <Field label="决定备注">
          <textarea
            name="note"
            className="decision-note"
            required
            maxLength={2000}
            rows={1}
            placeholder="写下备注"
            // Chosen from the row, the note is the next thing to write.
            autoFocus={onBack !== undefined && !routed}
          />
        </Field>
      )}
      <SubmitGroup className="decision-buttons" held={held}>
        {intents.map((intent, index) => (
          <button
            key={intent}
            type="submit"
            name="intent"
            value={intent}
            // The way forward is green; cancelling is the one red.
            className={
              intent === 'cancel'
                ? 'danger'
                : index > 0
                  ? 'secondary'
                  : undefined
            }
            formNoValidate={intent === 'claim'}
            onClick={() => {
              chosen.current = intent;
            }}
          >
            {labelOf(intent, task)}
          </button>
        ))}
        {onBack && (
          <button type="button" className="secondary" onClick={onBack}>
            返回
          </button>
        )}
      </SubmitGroup>
      {offline && (
        <p className="decision-help">工作区重新连上之前，操作暂停。</p>
      )}
    </ActionForm>
  );
}
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
