import type { Store } from '../persistence/store.js';

/**
 * Says when the team's state may have changed, so each open view can ask
 * whether what it shows did. SQLite cannot notify across processes, so the
 * hub reads its in-memory write counters (the worker's and Team MCP's commits
 * as well as its own), the set of awake agents and the set of people online,
 * which change without any write when a worker or a browser falls silent.
 */
export function watchChanges(store: Store, everyMs = 200) {
  const listeners = new Set<() => void>();
  const mark = () => {
    const now = Date.now();
    return [
      store.writes(),
      store.inbox.awake(now).join(','),
      store.online(now).join(','),
    ].join('|');
  };
  let last = mark();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const timer = setInterval(() => {
    const next = mark();
    if (next === last) return;
    last = next;
    emit();
  }, everyMs);
  timer.unref();
  return {
    /** For state the hub keeps in memory, such as a T3 sign-in under way. */
    emit,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      clearInterval(timer);
      listeners.clear();
    },
  };
}
export type Changes = ReturnType<typeof watchChanges>;
