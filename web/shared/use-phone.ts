import { useMedia } from './use-media.js';

/** True on a phone-sized screen, where places stack instead of sitting side by side. */
export function usePhone() {
  return useMedia('(max-width: 575px)');
}
