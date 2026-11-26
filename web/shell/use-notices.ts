import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

export interface Toast {
  id: number | string;
  message: string;
  detail?: string;
  url?: string;
}
/**
 * A short word at the foot of the screen, and what concerned you while you
 * were here as notices instead of notifications: each once, one after
 * another; a notice also opens its place. A toast stays while the pointer
 * or focus is on it.
 */
export function useNotices(data: WorkspaceSnapshot | null) {
  // A word said here, which goes before any notice.
  const [said, setSaid] = useState<Toast | null>(null);
  // In-page notices shown already, so a refresh doesn't show them again.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const notice = said ? undefined : data?.notices.find((n) => !shown.has(n.id));
  const toast: Toast | null =
    said ??
    (notice
      ? {
          id: 'notice:' + notice.id,
          message: notice.title,
          detail: notice.body,
          url: notice.url,
        }
      : null);
  /** The toast on screen goes; the next notice, if any, follows. */
  const noticeId = notice?.id;
  const dismiss = useCallback(() => {
    if (noticeId === undefined) setSaid(null);
    else setShown((old) => new Set(old).add(noticeId));
  }, [noticeId]);
  const id = toast?.id;
  const lasting = toast?.url ? 8000 : 4000;
  // What holds the toast on screen: the pointer over it, focus in it.
  const [holding, setHolding] = useState<{
    id: Toast['id'] | undefined;
    by: ReadonlySet<'pointer' | 'focus'>;
  }>({ id: undefined, by: new Set() });
  const held = holding.id === id && holding.by.size > 0;
  /** While held, a toast waits; let go, it has its whole time again. */
  const hold = useCallback(
    (by: 'pointer' | 'focus', on: boolean) => {
      setHolding((old) => {
        const next = new Set(old.id === id ? old.by : []);
        if (on) next.add(by);
        else next.delete(by);
        return { id, by: next };
      });
    },
    [id],
  );
  useEffect(() => {
    if (id === undefined || held) return;
    const timer = setTimeout(dismiss, lasting);
    return () => {
      clearTimeout(timer);
    };
  }, [id, lasting, dismiss, held]);
  const notify = (message: string) => {
    setSaid({ id: Date.now(), message });
  };
  return { toast, dismiss, notify, hold };
}
export type Notices = ReturnType<typeof useNotices>;
