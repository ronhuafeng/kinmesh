import { useState } from 'react';
import { Task } from '../../src/domain/tasks.js';
import { pageOf, memberKey } from '../../src/domain/communication.js';
import { api } from '../shared/api.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { PriorityIcon, PlusIcon } from '../shared/icons.js';
import {
  humanAsk,
  cardMarker,
  type StageId,
  stages,
  stageOf,
} from '../shared/task-status.js';
import { late, dueLabel, yours, byUrgency, byFinish } from './model.js';
import { MemberAvatar } from './members.js';
import { useToday } from '../shared/clock.js';
import { memberName, topicTitle } from '../shared/names.js';
import { ALL_TASKS, type BoardFilter } from '../shared/board-filter.js';
import { PlaceLink } from '../shared/place-link.js';
import { untilFound } from '../shared/until-found.js';

/**
 * The channel's finished tasks older than those the board starts with
 * (`data.tasks`), read a page at a time from the cursor each page gives.
 */
export function useOlderTasks(path: string, first: string | null) {
  const [state, setState] = useState<{
    path: string;
    items: Task[];
    cursor: string | null | undefined;
  }>({ path, items: [], cursor: undefined });
  const current =
    state.path === path
      ? state
      : { path, items: [] as Task[], cursor: undefined };
  const cursor = current.cursor === undefined ? first : current.cursor;
  const [busy, setBusy] = useState(false);
  const load = () => {
    if (cursor === null || busy) return;
    setBusy(true);
    void api(
      path + '?finished=true&limit=100&cursor=' + encodeURIComponent(cursor),
    )
      .then((raw) => {
        const page = pageOf(Task).parse(raw);
        setState((old) => {
          const kept = old.path === path ? old.items : [];
          const ids = new Set(kept.map((t) => t.id));
          return {
            path,
            items: [...kept, ...page.items.filter((t) => !ids.has(t.id))],
            cursor: page.nextCursor,
          };
        });
      })
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  };
  return { items: current.items, more: cursor !== null, load, busy };
}
export function TaskCard({
  task,
  data,
  open,
  href,
  onOpen,
}: {
  task: Task;
  data: WorkspaceSnapshot;
  /** Its page is open beside the board. */
  open: boolean;
  /** Its page's address. */
  href: string;
  onOpen: () => void;
}) {
  const ask = humanAsk(task, data);
  const today = useToday();
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
      <h4>
        <PlaceLink className="card-link" href={href} onOpen={onOpen}>
          {task.priority === 'high' && (
            <span className="card-priority" title="高优先级">
              <PriorityIcon />
              <span className="visually-hidden">高优先级：</span>
            </span>
          )}
          {task.title}
        </PlaceLink>
      </h4>
      {(ask ?? task.due ?? task.state.owner ?? task.state.reviewer) && (
        <footer>
          {ask && <p className="ask-label">{ask}</p>}
          {task.due && (
            <time
              className="card-due"
              dateTime={task.due}
              data-late={late(task, today) ? 'true' : undefined}
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
export function Board({
  data,
  openTask,
  taskHref,
  onNewTask,
  openId = null,
  filter = ALL_TASKS,
  onFilter = () => undefined,
}: {
  data: WorkspaceSnapshot;
  openTask: (id: string) => void;
  /** A task page's address. */
  taskHref: (id: string) => string;
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
  const held = new Set(data.tasks.items.map((t) => t.id));
  const every = [
    ...data.tasks.items,
    ...older.items.filter((t) => !held.has(t.id)),
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
    title: topicTitle(data, id) ?? '话题',
  }));
  // An owner or topic the board doesn't hold (kept from before) narrows
  // nothing here.
  const who =
    filter.who === 'mine' || owners.has(filter.who) ? filter.who : 'all';
  const topic = topics.some((t) => t.id === filter.topic) ? filter.topic : '';
  const items = every.filter(
    (t) =>
      (who === 'all' ||
        (who === 'mine'
          ? yours(t, data.human.id)
          : t.state.owner !== null && memberKey(t.state.owner) === who)) &&
      (topic === '' || t.topicId === topic),
  );
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelled = items.filter((t) => t.state.status === 'cancelled');
  const byStage = new Map<StageId, Task[]>(stages.map((s) => [s.id, []]));
  for (const task of items)
    if (showCancelled || task.state.status !== 'cancelled')
      byStage.get(stageOf(task.state.status))?.push(task);
  // Open work by urgency; what is done, the most recently finished first.
  for (const [stage, list] of byStage)
    list.sort(stage === 'done' ? byFinish : byUrgency);
  const firstAsk = stages.find((s) =>
    byStage.get(s.id)?.some((t) => humanAsk(t, data)),
  );
  const [column, setColumn] = useState<StageId>(firstAsk?.id ?? 'proposed');
  // One stage at a time shows the stage of the task that is open.
  const openStage = items.find((t) => t.id === openId)?.state.status;
  const [shownStage, setShownStage] = useState<typeof openStage>(undefined);
  if (shownStage !== openStage) {
    setShownStage(openStage);
    if (openStage) setColumn(stageOf(openStage));
  }
  return (
    <section aria-label="任务看板">
      <div className="board-filter" role="group" aria-label="筛选任务">
        <div className="segmented" role="group" aria-label="谁的任务">
          {(
            [
              ['all', '全部'],
              ['mine', '我的'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={who === value}
              onClick={() => {
                onFilter({ ...filter, who: value });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {owners.size > 1 && (
          <select
            aria-label="负责人"
            value={owners.has(who) ? who : ''}
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
              // A stage a narrow board isn't showing is still found by find
              // in page, which shows it.
              ref={untilFound(column !== s.id, () => {
                setColumn(s.id);
              })}
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
                  href={taskHref(task.id)}
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
