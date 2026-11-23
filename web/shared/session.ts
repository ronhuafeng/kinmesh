/**
 * Unsent work kept in this browser tab, so a reload doesn't lose it. Storage
 * can be refused (private windows, blocked site data); then nothing is kept
 * and nothing breaks.
 */
export function keep(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem('kinmesh:' + key);
    else sessionStorage.setItem('kinmesh:' + key, JSON.stringify(value));
  } catch {
    // Not kept; the page works the same.
  }
}
export function kept(key: string): unknown {
  try {
    const raw = sessionStorage.getItem('kinmesh:' + key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
