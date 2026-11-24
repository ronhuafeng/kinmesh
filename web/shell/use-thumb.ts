import { useCallback, useLayoutEffect, useRef } from 'react';

/** The tab each list's thumb was last put under. */
const marked = new WeakMap<HTMLElement, HTMLElement>();
/**
 * Puts the views' one thumb under the chosen tab, or hides it on no tab. It
 * slides only to a newly chosen tab; when the same tab moves or changes size
 * (the window, a breakpoint) it goes with it at once, or it would trail
 * behind the tab it marks.
 */
function placeThumb(list: HTMLElement | null) {
  if (!list) return;
  const tab = list.querySelector<HTMLElement>(
    '[role="tab"][data-state="active"]',
  );
  if (!tab) {
    delete list.dataset.thumb;
    return;
  }
  const x = String(tab.offsetLeft) + 'px';
  const w = String(tab.offsetWidth) + 'px';
  const chosen = marked.get(list) !== tab;
  marked.set(list, tab);
  const unmoved =
    list.style.getPropertyValue('--thumb-x') === x &&
    list.style.getPropertyValue('--thumb-w') === w;
  if (!chosen && unmoved && list.dataset.thumb) return;
  if (!chosen && list.dataset.thumb) delete list.dataset.thumb;
  list.style.setProperty('--thumb-x', x);
  list.style.setProperty('--thumb-w', w);
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
