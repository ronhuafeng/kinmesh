import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

/**
 * The new snapshot, keeping each message as the one before had it when it
 * is unchanged: a row whose message is the same object is not drawn again.
 */
export function keepUnchanged(
  previous: WorkspaceSnapshot | null,
  next: WorkspaceSnapshot,
): WorkspaceSnapshot {
  if (!previous) return next;
  const kept = new Map(previous.messages.items.map((m) => [m.id, m]));
  return {
    ...next,
    messages: {
      ...next.messages,
      items: next.messages.items.map((m) => {
        const old = kept.get(m.id);
        return old && JSON.stringify(old) === JSON.stringify(m) ? old : m;
      }),
    },
  };
}
