import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

/**
 * A phone lists channels as conversations: the newest message first (by
 * name among those without one).
 */
export function byActivity(
  channels: WorkspaceSnapshot['channels']['items'],
  latest: WorkspaceSnapshot['latest'],
) {
  const at = new Map(latest.map((l) => [l.channelId, l.createdAt]));
  return [...channels].sort((a, b) => {
    const x = at.get(a.id) ?? '';
    const y = at.get(b.id) ?? '';
    return x === y ? a.name.localeCompare(b.name, 'zh-CN') : x < y ? 1 : -1;
  });
}
