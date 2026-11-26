import { flushSync } from 'react-dom';

/**
 * A ref for what is out of sight but not gone (`hidden="until-found"`, which
 * React can't set): find in page still reaches it, and a match there calls
 * `found` to bring it on screen before the browser scrolls to the match. A
 * browser without it hides the element, as its stylesheet says.
 */
export function untilFound(hidden: boolean, found: () => void) {
  return (el: HTMLElement | null) => {
    if (!el) return;
    if (hidden) el.setAttribute('hidden', 'until-found');
    else el.removeAttribute('hidden');
    const onMatch = () => {
      flushSync(found);
    };
    el.addEventListener('beforematch', onMatch);
    return () => {
      el.removeEventListener('beforematch', onMatch);
    };
  };
}
