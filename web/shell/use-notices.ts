import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

export interface Toast {
  id: number;
  message: string;
  detail?: string;
  url?: string;
}
/**
 * A short word at the foot of the screen, and what concerned you while you
 * were here as notices instead of notifications: each once, one after
 * another; a notice also opens its place.
 */
export function useNotices(data: WorkspaceSnapshot | null) {
  const [toast, setToast] = useState<Toast | null>(null);
  // In-page notices shown already, so a refresh doesn't show them again.
  const noticed = useRef(new Set<string>());
  // Notices still to show, one after another.
  const [queuedNotices, setQueuedNotices] = useState<
    { id: string; title: string; body: string; url: string }[]
  >([]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => {
        setToast(null);
      },
      toast.url ? 8000 : 4000,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);
  const notices = data?.notices;
  useEffect(() => {
    const fresh = (notices ?? []).filter((n) => !noticed.current.has(n.id));
    if (fresh.length === 0) return;
    for (const n of fresh) noticed.current.add(n.id);
    setQueuedNotices((old) => [...old, ...fresh]);
  }, [notices]);
  // The next notice shows once the one before it has gone.
  useEffect(() => {
    const [next, ...rest] = queuedNotices;
    if (toast || !next) return;
    setQueuedNotices(rest);
    setToast({
      id: Date.now(),
      message: next.title,
      detail: next.body,
      url: next.url,
    });
  }, [toast, queuedNotices]);
  const notify = (message: string) => {
    setToast({ id: Date.now(), message });
  };
  return { toast, setToast, notify };
}
export type Notices = ReturnType<typeof useNotices>;
