import type { Store } from '../persistence/store.js';

/**
 * Says when the team's state may have changed, so each open view can ask
 * whether what it shows did. A commit anywhere, the worker's and Team MCP's
 * included, is announced by PostgreSQL (LISTEN/NOTIFY). Who is awake or
 * online changes without any write, as a worker or a browser falls silent,
 * so those two are looked at every `everyMs`.
 */
export function watchChanges(store: Store, everyMs = 1000) {
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  let closed = false;
  const unlisten = store.listen(emit).catch(() => undefined);
  const presence = async () => {
    const now = Date.now();
    return [
      (await store.inbox.awake(now)).join(','),
      (await store.online(now)).join(','),
    ].join('|');
  };
  // Unknown until first read: the first look announces nothing.
  let last: string | undefined;
  // One look at a time; a slow one is not overtaken by the next.
  let looking = false;
  const look = async () => {
    if (looking || closed) return;
    looking = true;
    try {
      const next = await presence();
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
      closed = true;
      clearInterval(timer);
      listeners.clear();
      void unlisten.then((stop) => stop?.());
    },
  };
}
export type Changes = ReturnType<typeof watchChanges>;
