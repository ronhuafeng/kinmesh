import { useMedia } from './use-media.js';

/**
 * Beside the sidebar, how much room there is: narrow (576–899 px, an upright
 * tablet) or wide; null on a phone, where places stack.
 */
export function usePad(): 'narrow' | 'wide' | null {
  const narrow = useMedia('(min-width: 576px) and (max-width: 899px)');
  const wide = useMedia('(min-width: 900px)');
  return narrow ? 'narrow' : wide ? 'wide' : null;
}
