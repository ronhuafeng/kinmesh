import { useSyncExternalStore } from 'react';

/**
 * 外观: follow the system, or always light or dark. Kept in this browser
 * (`boot.ts` applies it before the page is drawn), and followed by every
 * open tab of it.
 */
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'kinmesh-theme';
const listeners = new Set<() => void>();
export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
/**
 * Shows a theme on this page: its colours, and the browser's title bar.
 * Each theme-color names the scheme it is for; a chosen scheme's holds
 * whatever the system says.
 */
function showTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"][data-scheme]',
  )) {
    const scheme = meta.dataset.scheme;
    meta.media =
      theme === 'system'
        ? `(prefers-color-scheme: ${scheme ?? 'light'})`
        : scheme === theme
          ? 'all'
          : 'not all';
  }
  for (const listener of listeners) listener();
}
export function applyTheme(theme: Theme) {
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Not kept, but still applied to this page.
  }
  showTheme(theme);
}
/**
 * Follows the theme as it is chosen, here or in another open tab. Called
 * once as the app starts.
 */
export function followTheme() {
  showTheme(readTheme());
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) showTheme(readTheme());
  });
}
/** The theme as chosen, kept current when another tab chooses again. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
