import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import type { Command, Remote } from '../search/palette.js';
import { humanAsk, statusLabel } from '../shared/task-status.js';
import type { Actions } from './actions.js';
import type { Screen } from './screen.js';
import type { Place } from './use-place.js';
import { z } from 'zod';
import { Author } from '../../src/domain/agents.js';
import { TeamFile } from '../../src/domain/communication.js';
import { api } from '../shared/api.js';
import { memberName } from '../shared/names.js';

/**
 * What search offers to do: what waits on you, the views, every channel,
 * agent and task, then the actions on the channel on screen.
 */
export function commandsOf(
  data: WorkspaceSnapshot,
  place: Place,
  screen: Screen,
  actions: Actions,
  refreshNow: () => void,
): Command[] {
  const { setView, selectChannel, openAgent, openTask, startNewTask } = place;
  const { channel, channelPath, onScreen, directWith, channelLevel } = screen;
  const { openTaskIn, changeLevel, leaveChannel } = actions;
  return [
    ...data.attention.decide.map(({ task, channelName }) => ({
      id: 'ask-' + task.id,
      group: '收件箱',
      label: task.title,
      hint: (humanAsk(task, data) ?? '等你决定') + ' · #' + channelName,
      run: () => {
        openTaskIn(task.channelId, task.id);
      },
    })),
    ...(['chat', 'board', 'team', 'files'] as const).map((v) => ({
      id: 'view-' + v,
      group: '视图',
      label: { chat: '聊天', board: '看板', team: '成员', files: '文件' }[v],
      run: () => {
        setView(v);
      },
    })),
    // Places to go first, so a name typed finds its place before an
    // action that mentions it; then the actions.
    ...data.channels.items.map((c) => ({
      id: 'channel-' + c.id,
      group: '频道',
      label: (directWith.has(c.id) ? '' : '# ') + c.name,
      // Its icon says it is a channel; the "#" stays for screen readers.
      channel: { id: c.id, name: c.name },
      run: () => {
        selectChannel(c.id);
      },
    })),
    ...data.agents.map((agent) => ({
      id: 'agent-' + agent.id,
      group: '成员',
      label: agent.name,
      run: () => {
        openAgent(agent.id);
      },
    })),
    ...data.tasks.items.map((task) => ({
      id: 'task-' + task.id,
      group: '任务',
      label: task.title,
      hint:
        '#' + String(task.position) + ' · ' + statusLabel(task.state.status),
      run: () => {
        openTask(task.id);
      },
    })),
    ...(channelPath
      ? [
          {
            id: 'action-new-task',
            group: '操作',
            label: '新任务',
            hint: channel ? '#' + channel.name : undefined,
            run: startNewTask,
          },
        ]
      : []),
    // Only the channel on screen can be left: never the one a switch is
    // leaving behind.
    ...(channel && channelPath && onScreen
      ? [
          {
            id: 'action-mute',
            group: '操作',
            label:
              (channelLevel === 'mute' ? '取消静音 #' : '静音 #') +
              channel.name,
            run: () => {
              changeLevel(channelLevel === 'mute' ? 'default' : 'mute');
            },
          },
          {
            id: 'action-follow',
            group: '操作',
            label:
              (channelLevel === 'follow'
                ? '只通知与我有关的 #'
                : '每条消息都通知 #') + channel.name,
            run: () => {
              changeLevel(channelLevel === 'follow' ? 'default' : 'follow');
            },
          },
          {
            id: 'action-leave',
            group: '操作',
            label: '退出 #' + channel.name,
            run: leaveChannel,
          },
        ]
      : []),
    {
      id: 'action-refresh',
      group: '操作',
      label: '立即刷新',
      run: refreshNow,
    },
  ];
}
/** What the hub's search finds: messages and files, newest first. */
const SearchFound = z.object({
  messages: z.array(
    z.object({
      messageId: z.string(),
      channelId: z.string(),
      excerpt: z.string(),
      author: Author,
    }),
  ),
  files: z.array(TeamFile),
});
/** Messages and files the hub finds for what is typed in search. */
export function remoteSearch(
  data: WorkspaceSnapshot,
  openMessageIn: (channelId: string, messageId: string) => void,
): Remote {
  return async (query, signal) => {
    const found = SearchFound.parse(
      await api(
        `/api/teams/${data.team.id}/search?q=${encodeURIComponent(query)}`,
        { signal },
      ),
    );
    const where = (channelId: string) =>
      '#' +
      (data.channels.items.find((c) => c.id === channelId)?.name ?? '频道');
    return [
      ...found.messages.map((m) => ({
        id: 'message-' + m.messageId,
        group: '消息',
        label: m.excerpt,
        hint: memberName(m.author, data) + ' · ' + where(m.channelId),
        run: () => {
          openMessageIn(m.channelId, m.messageId);
        },
      })),
      ...found.files.map((f) => ({
        id: 'file-' + f.attachment.id,
        group: '文件',
        label: f.attachment.name,
        hint: where(f.channelId),
        run: () => {
          openMessageIn(f.channelId, f.messageId);
        },
      })),
    ];
  };
}
