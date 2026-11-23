import { ChannelView } from '../../src/domain/communication.js';
import type { ChannelLevel } from '../../src/domain/notify.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { api, request } from '../shared/api.js';
import { setLevel } from '../shared/levels.js';
import { unsubscribe } from '../shared/push.js';
import { SIGNED_OUT } from './auth.js';
import type { Screen } from './screen.js';
import type { Place } from './use-place.js';
import type { Workspace } from './use-workspace.js';

/** You signed out here: the sign-in page waits for you to sign in again. */
function markSignedOut() {
  try {
    sessionStorage.setItem(SIGNED_OUT, '1');
  } catch {
    // Storage refused: inside Feishu the page may sign you back in.
  }
}
/**
 * What the shell does for you that reaches the hub or crosses places:
 * signing out, leaving a channel, changing how loud it is, opening a task,
 * a message or a conversation wherever it is.
 */
export function actionsOf(
  data: WorkspaceSnapshot,
  place: Place,
  screen: Screen,
  workspace: Workspace,
  notify: (message: string) => void,
) {
  const { channel, channelPath, canAct, stale } = screen;
  const { selectChannel, setSelection, setView, setFocus, setTarget } = place;
  const { refresh, toSignedOut } = workspace;
  /** What an action that can't go now says, instead of nothing. */
  const cannot = () => {
    notify(
      stale ? '连不上 Kinmesh，恢复连接后再试。' : '页面还在更新，请稍后再试。',
    );
  };
  /** Signs out here, or everywhere, after this browser stops being notified. */
  const leaveWith = (path: string) => {
    if (!canAct) {
      cannot();
      return;
    }
    // This browser stops being notified for you before you leave it.
    void unsubscribe()
      .catch(() => undefined)
      .then(() => api(path, { method: 'POST' }))
      .then(() => {
        markSignedOut();
        toSignedOut();
      })
      .catch(() => {
        notify('没能退出登录，请再试一次。');
      });
  };
  /** Leaves any channel you are in, from its row's menu or from search. */
  const leaveChannelById = (id: string) => {
    if (!canAct) {
      cannot();
      return;
    }
    void api(`/api/teams/${data.team.id}/channels/${id}/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationKey: crypto.randomUUID() }),
    })
      .then(() => {
        if (id === channel?.id) selectChannel('');
      })
      .catch(() => {
        notify('没能退出频道，请再试一次。');
      });
  };
  /** Open a task in any joined channel; its page appears once it loads. */
  const openTaskIn = (channelId: string, id: string) => {
    if (channelId !== channel?.id) selectChannel(channelId);
    place.openTask(id);
  };
  /**
   * Opens a message in its channel's conversation (every topic's messages
   * are there too), reaching back as far as it is.
   */
  const openMessageIn = (id: string, messageId: string) => {
    setFocus(null);
    if (id !== channel?.id) selectChannel(id);
    else setSelection((old) => ({ ...old, topic: '' }));
    setView('chat');
    setTarget({ channel: id, topic: '', id: messageId });
  };
  return {
    cannot,
    signOut: () => {
      leaveWith('/api/logout');
    },
    signOutEverywhere: () => {
      leaveWith('/api/me/sessions/end');
    },
    /** Leaves the open channel, from the command palette. */
    leaveChannel: () => {
      if (channelPath && channel) leaveChannelById(channel.id);
    },
    leaveChannelById,
    changeLevel: (level: ChannelLevel) => {
      if (!channel) return;
      if (!canAct) {
        cannot();
        return;
      }
      void setLevel(data.team.id, channel.id, level).catch(() => {
        notify('没能改好，请再试一次。');
      });
    },
    openTaskIn,
    openMessageIn,
    /** Opens your own conversation with someone, made the first time. */
    openDirect: (humanId: string) => {
      void request(`/api/teams/${data.team.id}/direct`, {
        operationKey: crypto.randomUUID(),
        humanId,
      }).then(
        (raw) => {
          const opened = ChannelView.safeParse(raw);
          if (!opened.success) return;
          place.leavePage();
          setView('chat');
          selectChannel(opened.data.id);
          refresh();
        },
        () => {
          notify('没能打开对话，请再试一次。');
        },
      );
    },
  };
}
export type Actions = ReturnType<typeof actionsOf>;
