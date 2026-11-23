import { flushSync } from 'react-dom';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

/** True when a refresh moved at least one visible task to another status. */
function statusesMoved(
  before: WorkspaceSnapshot | null,
  after: WorkspaceSnapshot,
) {
  if (!before || before.channel?.id !== after.channel?.id) return false;
  const old = new Map(before.tasks.items.map((t) => [t.id, t.state.status]));
  return after.tasks.items.some((t) => {
    const status = old.get(t.id);
    return status !== undefined && status !== t.state.status;
  });
}
function animate(update: () => void) {
  if (
    typeof document.startViewTransition !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}
/**
 * Puts a new snapshot on screen: cards on screen travel to their new
 * column; other refreshes stay instant.
 */
export function animateBoard(
  before: WorkspaceSnapshot | null,
  after: WorkspaceSnapshot,
  apply: () => void,
) {
  if (document.querySelector('.board') && statusesMoved(before, after))
    animate(apply);
  else apply();
}
