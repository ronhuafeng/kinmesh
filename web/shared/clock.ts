import { useSyncExternalStore } from 'react';

/**
 * The one clock the app shares, so what a page says about time stays true
 * as time passes without anything new arriving: the day turns at local
 * midnight, and "5 分钟前" moves on each minute while the page is seen. One
 * timer serves every reader; a tab nobody sees counts no minutes, and reads
 * the time again as it is shown.
 */
function ticking(read: () => number, next: (now: number) => number) {
  let value = read();
  const readers = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const now = read();
    if (now === value) return;
    value = now;
    for (const reader of readers) reader();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (readers.size === 0 || document.hidden) return;
    const now = Date.now();
    timer = setTimeout(
      () => {
        update();
        schedule();
      },
      Math.max(0, next(now) - now),
    );
  };
  const shown = () => {
    update();
    schedule();
  };
  return {
    subscribe: (reader: () => void) => {
      readers.add(reader);
      if (readers.size === 1) {
        // Nobody read it meanwhile: it is current before it is first read.
        value = read();
        document.addEventListener('visibilitychange', shown);
        schedule();
      }
      return () => {
        readers.delete(reader);
        if (readers.size > 0) return;
        document.removeEventListener('visibilitychange', shown);
        clearTimeout(timer);
        timer = undefined;
      };
    },
    get: () => value,
  };
}
/** The local midnight a moment falls after. */
function midnightOf(at: number) {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}
const day = ticking(
  () => midnightOf(Date.now()),
  (now) => {
    const next = new Date(midnightOf(now));
    next.setDate(next.getDate() + 1);
    return next.getTime();
  },
);
const minute = ticking(
  () => Math.floor(Date.now() / 60_000) * 60_000,
  (now) => (Math.floor(now / 60_000) + 1) * 60_000,
);
/** Today, as its local midnight: it changes as the day turns. */
export function useToday() {
  return new Date(useSyncExternalStore(day.subscribe, day.get));
}
/** Now, to the minute: it moves on each minute while the page is seen. */
export function useMinute() {
  return useSyncExternalStore(minute.subscribe, minute.get);
}
