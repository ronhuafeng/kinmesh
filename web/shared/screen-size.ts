import { useSyncExternalStore } from 'react';

/** Whether a media query matches now, following it as it changes. */
export function useMedia(media: string) {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(media);
      query.addEventListener('change', changed);
      return () => {
        query.removeEventListener('change', changed);
      };
    },
    () => window.matchMedia(media).matches,
    () => false,
  );
}
/** True on a phone-sized screen, where places stack instead of sitting side by side. */
export function usePhone() {
  return useMedia('(max-width: 575px)');
}
/**
 * Beside the sidebar, how much room there is: narrow (576–899 px, an upright
 * tablet) or wide; null on a phone, where places stack.
 */
export function usePad(): 'narrow' | 'wide' | null {
  const narrow = useMedia('(min-width: 576px) and (max-width: 899px)');
  const wide = useMedia('(min-width: 900px)');
  return narrow ? 'narrow' : wide ? 'wide' : null;
}
