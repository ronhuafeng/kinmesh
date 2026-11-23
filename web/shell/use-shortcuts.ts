import { useEffect } from 'react';
import type { Place } from './use-place.js';

/**
 * A phone's search is a tab, which ⌘K opens (and closes again); a wider
 * screen searches from the sidebar. ⌘, (Ctrl+, elsewhere) opens settings,
 * as in any Mac app.
 */
export function useShortcuts(phone: boolean, place: Place) {
  const { setFocus, setDraft } = place;
  useEffect(() => {
    if (!phone) {
      setFocus((old) => (old?.kind === 'search' ? null : old));
      return;
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      setDraft(null);
      setFocus((old) => (old?.kind === 'search' ? null : { kind: 'search' }));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [phone, setFocus, setDraft]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ',' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setFocus({ kind: 'settings', section: '' });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [setFocus]);
}
