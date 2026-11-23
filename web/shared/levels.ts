import type { ChannelLevel } from '../../src/domain/notify.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { request } from './api.js';

/** How loud each level is, in the person's words. */
export const LEVEL_LABELS: Record<ChannelLevel, string> = {
  default: '与我有关',
  follow: '每条消息',
  mute: '静音',
};
/** How loud a channel is for you: the default unless you changed it. */
export const levelOf = (
  data: WorkspaceSnapshot,
  channelId: string,
): ChannelLevel =>
  data.levels.find((l) => l.channelId === channelId)?.level ?? 'default';
/** Sets how loud a channel is for you; the workspace then shows it. */
export const setLevel = (
  teamId: string,
  channelId: string,
  level: ChannelLevel,
) => request(`/api/teams/${teamId}/channels/${channelId}/level`, { level });
