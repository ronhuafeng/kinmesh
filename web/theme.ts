/**
 * 外观: follow the system, or always light or dark. Kept in this browser
 * (`boot.ts` applies it before the page is drawn).
 */
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'kinmesh-theme';
export function readTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(theme: Theme) {
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Not kept, but still applied to this page.
  }
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
