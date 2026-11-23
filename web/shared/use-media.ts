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
