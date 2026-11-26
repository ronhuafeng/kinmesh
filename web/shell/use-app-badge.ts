import { useEffect } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { attentionCount, badgeOf } from '../inbox/attention.js';

/**
 * The app's badge, where the browser shows one: how many decisions wait on
 * you; else a dot while anything is unread; else nothing, as when signed
 * out.
 */
export function badgeFor(
  seen: Pick<WorkspaceSnapshot, 'attention' | 'latest'>,
) {
  return badgeOf(
    attentionCount(seen.attention),
    seen.latest.some((l) => l.unread),
  );
}
/**
 * Puts a badge on the app. A hidden tab puts the one its newest snapshot
 * calls for straight away, while that snapshot waits to be shown.
 */
export function putBadge(badge: ReturnType<typeof badgeFor>) {
  if (!('setAppBadge' in navigator)) return;
  void (
    badge === null
      ? navigator.clearAppBadge()
      : badge === true
        ? navigator.setAppBadge()
        : navigator.setAppBadge(badge)
  ).catch(() => undefined);
}
/** The badge of the workspace on screen. */
export function useAppBadge(
  data: WorkspaceSnapshot | null,
  signedOut: boolean,
) {
  const badge = data && !signedOut ? badgeFor(data) : null;
  useEffect(() => {
    putBadge(badge);
  }, [badge]);
}
