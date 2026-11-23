import { useEffect, useState } from 'react';
import type { Task } from '../../src/domain/tasks.js';
import { memberKey } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName } from '../shared/names.js';
import { PlusIcon } from '../shared/icons.js';
import { ALL_TASKS, type BoardFilter } from '../shared/board-filter.js';
import { useOlderTasks } from './use-older-tasks.js';
import { yours, byUrgency } from './model.js';
import {
  type StageId,
  stages,
  stageOf,
  humanAsk,
} from '../shared/task-status.js';
import { TaskCard } from './task-card.js';

export function Board({
  data,
  openTask,
  onNewTask,
  openId = null,
  filter = ALL_TASKS,
  onFilter = () => undefined,
}: {
  data: WorkspaceSnapshot;
  openTask: (id: string) => void;
  onNewTask: () => void;
  /** The task whose page is open, beside the board on a wide tablet. */
  openId?: string | null;
  filter?: BoardFilter;
  onFilter?: (filter: BoardFilter) => void;
}) {
  const older = useOlderTasks(
    `/api/teams/${data.team.id}/channels/${data.channel?.id ?? ''}/tasks`,
    data.tasks.nextCursor,
  );
  const newest = new Set(data.tasks.items.map((t) => t.id));
  const every = [
    ...data.tasks.items,
    ...older.items.filter((t) => !newest.has(t.id)),
  ];
  // Who and which topic the board can be narrowed to: only those it holds.
  const owners = new Map<string, string>();
  for (const t of every)
    if (t.state.owner)
      owners.set(memberKey(t.state.owner), memberName(t.state.owner, data));
  const topics = [
    ...new Set(every.flatMap((t) => (t.topicId ? [t.topicId] : []))),
  ].map((id) => ({
    id,
    title: data.topics.items.find((topic) => topic.id === id)?.title ?? '话题',
  }));
  // A topic of another channel (kept from before) narrows nothing here.
  const topic = topics.some((t) => t.id === filter.topic) ? filter.topic : '';
  const items = every.filter(
    (t) =>
      (filter.who === 'all' ||
        (filter.who === 'mine'
          ? yours(t, data.human.id)
          : t.state.owner !== null &&
            memberKey(t.state.owner) === filter.who)) &&
      (topic === '' || t.topicId === topic),
  );
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelled = items.filter((t) => t.state.status === 'cancelled');
  const byStage = new Map<StageId, Task[]>(stages.map((s) => [s.id, []]));
  for (const task of items)
    if (showCancelled || task.state.status !== 'cancelled')
      byStage.get(stageOf(task.state.status))?.push(task);
  // Open work by urgency (ties stay newest first); what is done, newest first.
  for (const [stage, list] of byStage)
    if (stage !== 'done') list.sort(byUrgency);
  const firstAsk = stages.find((s) =>
    byStage.get(s.id)?.some((t) => humanAsk(t, data)),
  );
  const [column, setColumn] = useState<StageId>(firstAsk?.id ?? 'proposed');
  // One stage at a time shows the stage of the task that is open.
  const openStage = items.find((t) => t.id === openId)?.state.status;
  useEffect(() => {
    if (openStage) setColumn(stageOf(openStage));
  }, [openStage]);
  return (
    <section aria-label="任务看板">
      <div className="board-filter" role="group" aria-label="筛选任务">
        <div className="segmented" role="group" aria-label="谁的任务">
          {(
            [
              ['all', '全部'],
              ['mine', '我的'],
            ] as const
          ).map(([who, label]) => (
            <button
              key={who}
              type="button"
              aria-pressed={filter.who === who}
              onClick={() => {
                onFilter({ ...filter, who });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {owners.size > 1 && (
          <select
            aria-label="负责人"
            value={owners.has(filter.who) ? filter.who : ''}
            onChange={(event) => {
              onFilter({ ...filter, who: event.currentTarget.value || 'all' });
            }}
          >
            <option value="">所有负责人</option>
            {[...owners].map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        )}
        {topics.length > 0 && (
          <select
            aria-label="话题"
            value={topic}
            onChange={(event) => {
              onFilter({ ...filter, topic: event.currentTarget.value });
            }}
          >
            <option value="">所有话题</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* A narrow board shows one stage at a time. */}
      <div className="column-switcher" role="group" aria-label="阶段">
        {stages.map((s) => (
          <button
            key={s.id}
            type="button"
            data-status={s.tone}
            aria-pressed={column === s.id}
            onClick={() => {
              setColumn(s.id);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="board">
        {stages.map((s) => {
          const tasks = byStage.get(s.id) ?? [];
          return (
            <section
              key={s.id}
              className="board-column"
              data-status={s.tone}
              data-current={column === s.id ? 'true' : undefined}
              aria-label={s.label}
            >
              <h3 className="column-heading">
                <span className="dot" aria-hidden="true" />
                {s.label}
              </h3>
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  data={data}
                  open={task.id === openId}
                  onOpen={() => {
                    openTask(task.id);
                  }}
                />
              ))}
              {s.id === 'proposed' && (
                <button
                  type="button"
                  className="add-card"
                  aria-label="新任务"
                  onClick={onNewTask}
                >
                  <PlusIcon />
                </button>
              )}
              {s.id === 'done' && cancelled.length > 0 && (
                <button
                  type="button"
                  className="quiet column-toggle"
                  aria-pressed={showCancelled}
                  onClick={() => {
                    setShowCancelled((v) => !v);
                  }}
                >
                  {showCancelled ? '隐藏已取消' : '显示已取消'}
                </button>
              )}
              {/* Finished work goes back as far as the channel does. */}
              {s.id === 'done' && older.more && (
                <button
                  type="button"
                  className="quiet column-toggle"
                  disabled={older.busy}
                  onClick={older.load}
                >
                  更早的任务
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
