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
/**
 * Signed out, or access lost: nothing the last person left is kept in the
 * tab (drafts, messages not yet confirmed, a new task), so whoever signs in
 * here next never sees or sends it. The signed-out mark isn't `kinmesh:`, so
 * it stays.
 */
export function forgetAll() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('kinmesh:')) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // Storage refused: nothing was kept.
  }
}
