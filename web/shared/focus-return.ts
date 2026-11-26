import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * The same control drawn again: a "+" a field took the place of, a tile
 * whose view came back. Known by its tag, class and what it says.
 */
function drawnAgain(opener: HTMLElement): HTMLElement | null {
  const said = (el: Element) =>
    (el.getAttribute('aria-label') ?? '') + '\n' + el.textContent;
  for (const el of document.getElementsByTagName(opener.tagName)) {
    if (
      el instanceof HTMLElement &&
      el.className === opener.className &&
      said(el) === said(opener) &&
      el.checkVisibility()
    )
      return el;
  }
  return null;
}
/**
 * What opened something (a page, a field typed in place) has focus again
 * when it goes, if focus went with it: closing never leaves a keyboard or
 * screen-reader user at the start of the page. When the opener went too, it
 * is found drawn again, else `fallback` names what stands in for it.
 */
export function useFocusReturn(
  holder: RefObject<HTMLElement | null>,
  fallback?: () => Element | null | undefined,
) {
  // Read as it opens, before anything inside takes focus.
  const [opener] = useState(() => {
    const now = document.activeElement;
    return now instanceof HTMLElement && now !== document.body ? now : null;
  });
  const instead = useRef(fallback);
  useEffect(() => {
    instead.current = fallback;
  });
  useEffect(() => {
    const here = holder.current;
    return () => {
      // Gone from the page, with focus: not merely run again, and not
      // closed by moving somewhere else.
      if (here?.isConnected) return;
      const now = document.activeElement;
      if (now !== null && now !== document.body) return;
      const candidates = [
        opener,
        opener && !opener.isConnected ? drawnAgain(opener) : null,
        instead.current?.(),
      ];
      for (const candidate of candidates) {
        if (!(candidate instanceof HTMLElement) || !candidate.isConnected)
          continue;
        candidate.focus({ preventScroll: true });
        if (document.activeElement === candidate) return;
      }
    };
  }, [holder, opener]);
}
const focusable = 'button, [href], input, select, textarea, [tabindex="0"]';
/**
 * A field typed in place, over what it stood in for (a "+", a channel's
 * row): closed with focus, focus goes to its opener, else to what stands
 * where it stood.
 */
export function useFocusReturnInPlace(holder: RefObject<HTMLElement | null>) {
  const spot = useRef<{ parent: Element | null; before: Element | null }>({
    parent: null,
    before: null,
  });
  useEffect(() => {
    const here = holder.current;
    spot.current = {
      parent: here?.parentElement ?? null,
      before: here?.previousElementSibling ?? null,
    };
  }, [holder]);
  useFocusReturn(holder, () => {
    const { parent, before } = spot.current;
    const there = before
      ? before.nextElementSibling
      : parent?.firstElementChild;
    return there?.matches(focusable) ? there : there?.querySelector(focusable);
  });
}
