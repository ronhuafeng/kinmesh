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
  const mark = async () => {
    const now = Date.now();
    return [
      await store.writes(),
      (await store.inbox.awake(now)).join(','),
      (await store.online(now)).join(','),
    ].join('|');
  };
  // Unknown until first read: the first look announces nothing.
  let last: string | undefined;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  // One look at a time; a slow one is not overtaken by the next.
  let looking = false;
  const look = async () => {
    if (looking) return;
    looking = true;
    try {
      const next = await mark();
      if (last !== undefined && next !== last) emit();
      last = next;
    } catch {
      // A closed store has nothing to say; the next look tries again.
    } finally {
      looking = false;
    }
  };
  void look();
  const timer = setInterval(() => void look(), everyMs);
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
