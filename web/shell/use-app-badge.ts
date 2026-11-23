import { useEffect } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { attentionCount, badgeOf } from '../inbox/attention.js';

/**
 * The app's badge, where the browser shows one: how many decisions wait on
 * you; else a dot while anything is unread; else nothing, as when signed
 * out.
 */
export function useAppBadge(
  data: WorkspaceSnapshot | null,
  signedOut: boolean,
) {
  const badge =
    data && !signedOut
      ? badgeOf(
          attentionCount(data.attention),
          data.latest.some((l) => l.unread),
        )
      : null;
  useEffect(() => {
    if (!('setAppBadge' in navigator)) return;
    void (
      badge === null
        ? navigator.clearAppBadge()
        : badge === true
          ? navigator.setAppBadge()
          : navigator.setAppBadge(badge)
    ).catch(() => undefined);
  }, [badge]);
}
