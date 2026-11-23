import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

/** How many things wait on you: the Inbox's one number. */
export function attentionCount(attention: WorkspaceSnapshot['attention']) {
  return (
    attention.decide.length +
    attention.unstuck.length +
    attention.connect.length +
    (attention.t3 ? 1 : 0)
  );
}
/**
 * The app's badge: how many decisions wait on you; else a dot (`true`)
 * while anything is unread; else nothing (`null`).
 */
export function badgeOf(decisions: number, unread: boolean) {
  return decisions > 0 ? decisions : unread ? true : null;
}
