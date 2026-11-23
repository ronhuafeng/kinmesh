import { useEffect, useRef } from 'react';

/** ⌘K / Ctrl+K anywhere opens the search, or closes it again. */
export function useShortcut(toggle: () => void) {
  const latest = useRef(toggle);
  useEffect(() => {
    latest.current = toggle;
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        latest.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}
