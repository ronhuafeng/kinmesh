import { useCallback, useLayoutEffect, useRef } from 'react';

/** Puts the views' one thumb under the chosen tab, or hides it on no tab. */
function placeThumb(list: HTMLElement | null) {
  if (!list) return;
  const tab = list.querySelector<HTMLElement>(
    '[role="tab"][data-state="active"]',
  );
  if (!tab) {
    delete list.dataset.thumb;
    return;
  }
  list.style.setProperty('--thumb-x', String(tab.offsetLeft) + 'px');
  list.style.setProperty('--thumb-w', String(tab.offsetWidth) + 'px');
  if (list.dataset.thumb) return;
  // Shown where it belongs first; it slides from the next placement on.
  list.dataset.thumb = 'shown';
  requestAnimationFrame(() => {
    if (list.dataset.thumb) list.dataset.thumb = 'placed';
  });
}
/**
 * The views' thumb moves in the same commit as the content it shows, so the
 * two change together, and follows the tabs when their size changes.
 */
export function useThumb() {
  const list = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    placeThumb(list.current);
  });
  return useCallback((el: HTMLDivElement | null) => {
    list.current = el;
    if (!el) return;
    const resized = new ResizeObserver(() => {
      placeThumb(el);
    });
    resized.observe(el);
    return () => {
      resized.disconnect();
    };
  }, []);
}
