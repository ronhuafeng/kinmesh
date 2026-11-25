import { useState } from 'react';
import type { Task } from '../../src/domain/tasks.js';
import type { Member } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { DeliveryLine } from '../shared/deliveries.js';
import { taskDeliveries } from '../shared/deliveries.js';
import { Page } from '../shared/page.js';
import { DueIcon, PriorityIcon } from '../shared/icons.js';
import {
  taskActions,
  type Intent,
  withAgents,
  intentDone,
  late,
  dueLabel,
  priorityLabels,
  labelOf,
} from './model.js';
import { TaskEdit } from './task-edit.js';
import { TaskLayout } from './task-layout.js';
import { MemberChip } from './members.js';
import { SideValue } from './due-and-priority.js';
import { TaskDecision } from './decision.js';
import { TaskHistory } from './task-history.js';
import { TaskPullRequests, uncitedPullRequests } from './pull-requests.js';
import { CriterionProof } from './criterion-proof.js';
import { DecisionForm } from './decision.js';

export function TaskPage({
  task,
  data,
  path,
  onDone,
  onClose,
  onDecided,
  onReply,
  openAgent,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  path: string;
  onDone: () => void;
  onClose: () => void;
  onDecided: (message: string) => void;
  /** Opens a message (an agent's reply, a cited one) in the conversation. */
  onReply: (messageId: string) => void;
  openAgent: (agentId: string) => void;
}) {
  const topic = task.topicId
    ? data.topics.items.find((t) => t.id === task.topicId)
    : undefined;
  const acceptor = { kind: 'human', id: task.acceptorHumanId } satisfies Member;
  const { lead, rest, done } = taskActions(task, data);
  const judging = lead.some((i) => i === 'approve' || i === 'accept');
  // Deciding, the PRs not already under a criterion are part of the
  // decision; otherwise they follow the criteria.
  const decidedOnPullRequests =
    judging && uncitedPullRequests(task, data).length > 0;
  // One of the row's actions, chosen: its note opens in place of the row.
  const [picked, setPicked] = useState<Intent | null>(null);
  // Edited, the task is the page it was created on, filled in.
  const [editing, setEditing] = useState(false);
  const chosen = picked !== null && rest.includes(picked) ? picked : null;
  // After a decision lands, buttons wait for the new task version so a second
  // click can never re-send against the old one.
  const [decidedAt, setDecidedAt] = useState<number | null>(null);
  const held = decidedAt === task.version;
  const settled = () => {
    setPicked(null);
    setDecidedAt(task.version);
  };
  const deliveries = withAgents(task.state.status)
    ? taskDeliveries(data, task.id)
    : [];
  const decision = { task, data, path, held, onDone, onDecided };
  if (editing && rest.includes('edit'))
    return (
      <Page
        label={task.title}
        onClose={onClose}
        className="task-page"
        tabLeadsBack
        bar={data.channel ? '# ' + data.channel.name : ''}
      >
        <TaskEdit
          task={task}
          data={data}
          path={path}
          topic={topic?.title ?? null}
          onClose={() => {
            setEditing(false);
          }}
          onDone={() => {
            setEditing(false);
            onDecided(intentDone.edit);
            onDone();
          }}
        />
      </Page>
    );
  return (
    <Page
      label={task.title}
      onClose={onClose}
      className="task-page"
      tabLeadsBack
      // The title is the page's own first line; the bar says where it is.
      bar={data.channel ? '# ' + data.channel.name : ''}
    >
      <div className="page-body" data-status={task.state.status}>
        <TaskLayout
          status={task.state.status}
          title={<h2>{task.title}</h2>}
          description={
            // A task made from a message is often titled by all of it.
            task.description &&
            task.description.trim() !== task.title.trim() ? (
              <p className="task-description">{task.description}</p>
            ) : null
          }
          criteria={
            <ol className="criteria">
              {task.criteria.map((c, index) => (
                <li key={index}>
                  <span>{c}</span>
                  <CriterionProof
                    task={task}
                    criterion={c}
                    data={data}
                    onMessage={onReply}
                  />
                </li>
              ))}
            </ol>
          }
          owner={<MemberChip member={task.state.owner} data={data} />}
          reviewer={<MemberChip member={task.state.reviewer} data={data} />}
          acceptor={<MemberChip member={acceptor} data={data} />}
          due={
            task.due && (
              <SideValue icon={<DueIcon />}>
                <time
                  className="task-due"
                  dateTime={task.due}
                  data-late={late(task) ? 'true' : undefined}
                >
                  {dueLabel(task.due)}
                </time>
              </SideValue>
            )
          }
          priority={
            task.priority === 'normal' ? null : (
              <SideValue icon={<PriorityIcon />}>
                <span data-priority={task.priority}>
                  {priorityLabels[task.priority]}
                </span>
              </SideValue>
            )
          }
          topic={topic?.title ?? null}
          decision={
            <>
              {/* What waits on you leads; then where the task is now. */}
              {lead.length > 0 && (
                <TaskDecision
                  {...decision}
                  intents={lead}
                  onSettled={settled}
                />
              )}
              {/* Reviewing or accepting, its PRs and their checks are
                  what you decide on. */}
              {decidedOnPullRequests && (
                <TaskPullRequests task={task} data={data} path={path} />
              )}
              {deliveries.length > 0 && (
                <ul className="deliveries" aria-label="智能体响应">
                  {deliveries.map((d) => (
                    <DeliveryLine
                      key={d.id}
                      delivery={d}
                      data={data}
                      channelId={task.channelId}
                      onReply={onReply}
                      openAgent={openAgent}
                      onDone={onDone}
                    />
                  ))}
                </ul>
              )}
              {done && <p className="muted decision-none">任务已关闭。</p>}
            </>
          }
        >
          {!decidedOnPullRequests && (
            <TaskPullRequests task={task} data={data} path={path} />
          )}
          <TaskHistory task={task} path={path} data={data} />
          {chosen ? (
            <div className="task-actions">
              <DecisionForm
                {...decision}
                title={labelOf(chosen, task)}
                intents={[chosen]}
                onBack={() => {
                  setPicked(null);
                }}
                onSettled={settled}
              />
            </div>
          ) : (
            rest.length > 0 && (
              <div className="task-actions route-buttons">
                {rest.map((intent) => (
                  <button
                    key={intent}
                    type="button"
                    className={
                      intent === 'cancel' ? 'quiet subtle-danger' : 'quiet'
                    }
                    onClick={() => {
                      if (intent === 'edit') setEditing(true);
                      else setPicked(intent);
                    }}
                  >
                    {labelOf(intent, task)}
                  </button>
                ))}
              </div>
            )
          )}
        </TaskLayout>
      </div>
    </Page>
  );
}
