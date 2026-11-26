import { useEffect } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { sectionOf } from '../settings/sections.js';
import type { Place } from './use-place.js';

const VIEWS = { board: '看板', team: '成员', files: '文件', pins: '置顶' };
/**
 * The place's name, then Kinmesh: what a browser tab, a history entry and
 * the installed app's window say. A channel is "# name" (a conversation
 * with someone, their name), a view other than its chat comes before it.
 */
export function titleOf(data: WorkspaceSnapshot | null, place: Place) {
  const named = (parts: (string | null | undefined)[]) =>
    [...parts.filter(Boolean), 'Kinmesh'].join(' · ');
  if (!data) return named([]);
  const { focus, view, agentId, newTask } = place;
  const channel = data.channel;
  const channelName = channel
    ? (data.direct.some((d) => d.channelId === channel.id) ? '' : '# ') +
      channel.name
    : null;
  const agentName = (id: string) => data.agents.find((a) => a.id === id)?.name;
  if (focus?.kind === 'task') {
    const task =
      data.tasks.items.find((t) => t.id === focus.id) ??
      (data.openTask?.id === focus.id ? data.openTask : null);
    if (task) return named([task.title]);
  }
  if (focus?.kind === 'worker') return named([agentName(focus.id)]);
  if (focus?.kind === 'inbox') return named(['收件箱']);
  if (focus?.kind === 'search') return named(['搜索']);
  if (focus?.kind === 'settings')
    return named([sectionOf(focus.section)?.label, '设置']);
  if (newTask) return named(['新任务', channelName]);
  if (view === 'agent') return named([agentName(agentId)]);
  return named([view === 'chat' ? null : VIEWS[view], channelName]);
}
/** The document's title follows the place. */
export function useTitle(data: WorkspaceSnapshot | null, place: Place) {
  const title = titleOf(data, place);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
