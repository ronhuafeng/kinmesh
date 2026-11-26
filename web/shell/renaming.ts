import { useSyncExternalStore } from 'react';

/*
 * The channel being named again, in place in its row: started from its
 * menu or from search, ended by the field itself.
 */
let renaming: string | null = null;
const listeners = new Set<() => void>();
/** Names a channel again in its row; null ends it. */
export function startRenaming(id: string | null) {
  if (renaming === id) return;
  renaming = id;
  for (const changed of listeners) changed();
}
/** The channel whose row is a name field now, if any. */
export function useRenaming() {
  return useSyncExternalStore(
    (changed) => {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
    () => renaming,
    () => null,
  );
}
