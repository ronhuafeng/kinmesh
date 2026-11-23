import { useState } from 'react';
import { Task } from '../../src/domain/tasks.js';
import { pageOf } from '../../src/domain/communication.js';
import { api } from '../shared/api.js';

/**
 * The channel's tasks older than the board's newest (`data.tasks`), read a
 * page at a time from the cursor each page gives.
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
    void api(path + '?limit=100&cursor=' + encodeURIComponent(cursor))
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
