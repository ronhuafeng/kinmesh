import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { attentionCount } from '../inbox/attention.js';
import { joinedAgents } from '../shared/names.js';
import { levelOf } from '../shared/levels.js';
import type { Shared } from '../shared/share.js';
import { FIRST } from '../settings/sections.js';
import type { Place } from './use-place.js';
import type { Workspace } from './use-workspace.js';

/**
 * What the workspace shows now, read from the place, the snapshot and the
 * connection: nothing here is kept, everything follows from them.
 */
export function screenOf(
  data: WorkspaceSnapshot,
  place: Place,
  workspace: Workspace,
  phone: boolean,
  shared: Shared | null,
) {
  const { selection, focus, view, agentId, newTask } = place;
  const { status, loadedFor, lastOk, manual, slow, unreachable } = workspace;
  const channel = data.channel;
  const channelPath = channel
    ? `/api/teams/${data.team.id}/channels/${channel.id}`
    : null;
  // The snapshot on screen belongs to the selected channel (an empty selection
  // means the server's default, which is whatever arrived).
  const onScreen =
    loadedFor === selection.channel ||
    (channel !== null && selection.channel === channel.id);
  // Switching channels: the screen still holds the previous one.
  const switching = status === 'loading' && !onScreen;
  // Act on a confirmed snapshot of the channel in view. A background refresh
  // changes neither, so it never interrupts typing or sending.
  const canAct = lastOk && onScreen && status !== 'offline';
  // A refresh stays silent unless asked for or slow. What is on screen is
  // stale from a failed read until the next good one, retries included.
  const refreshing = lastOk && status === 'loading' && (manual || slow);
  const stale = unreachable;
  const shownChannelName = switching
    ? data.channels.items.find((c) => c.id === selection.channel)?.name
    : channel?.name;
  // Your own conversations, each by who it is with: called by them, with
  // their face, and no "#".
  const directWith = new Map<string, string>(
    data.direct.map((d) => [d.channelId, d.humanId]),
  );
  const shownDirect = directWith.has(
    switching ? selection.channel : (channel?.id ?? ''),
  );
  const channelAgents = joinedAgents(data);
  const focusedTask =
    focus?.kind === 'task' && channelPath
      ? (data.tasks.items.find((t) => t.id === focus.id) ??
        (data.openTask?.id === focus.id ? data.openTask : undefined))
      : undefined;
  const workerAgent =
    focus?.kind === 'worker'
      ? data.agents.find((a) => a.id === focus.id)
      : undefined;
  // An open page: a task or a new one (on the board), or the Inbox,
  // Settings or a hand-run worker (on no tab).
  // A task just created is a page already, while its first refresh arrives.
  const onBoardPage =
    channelPath !== null && (focus?.kind === 'task' || newTask !== null);
  const onPage =
    onBoardPage ||
    workerAgent !== undefined ||
    focus?.kind === 'inbox' ||
    focus?.kind === 'settings' ||
    focus?.kind === 'search' ||
    shared !== null;
  // A task (new or open) sits on the board and the Inbox is its own tab;
  // Settings and a hand-run worker sit on no tab. An agent's page is its own tab panel,
  // which no trigger lights.
  const tabValue = onBoardPage
    ? 'board'
    : focus?.kind === 'inbox'
      ? 'inbox'
      : onPage
        ? 'page'
        : view;
  /**
   * Where a phone is: Home (the channels and the team), a channel, a page
   * pushed over it, or a page reached from the bottom tabs. A wider screen
   * shows them side by side and ignores this.
   */
  const screen =
    focus?.kind === 'inbox' ||
    (focus?.kind === 'settings' && focus.section === '') ||
    focus?.kind === 'search'
      ? 'tab'
      : onPage || view === 'agent'
        ? 'page'
        : !selection.channel
          ? 'home'
          : 'channel';
  // How loud the open channel is for you, changed from search.
  const channelLevel = channel ? levelOf(data, channel.id) : 'default';
  // A public channel opened without joining it: there to read.
  const looking =
    channel !== null && !data.joinedHumanIds.includes(data.human.id);
  const pageAgent =
    view === 'agent' ? data.agents.find((a) => a.id === agentId) : undefined;
  const inSettings = focus?.kind === 'settings';
  const settingsSection =
    focus?.kind === 'settings'
      ? focus.section || (phone ? '' : FIRST.personal)
      : '';
  const waiting = attentionCount(data.attention);
  // The channels where something waits on you.
  const waitingIn = new Set<string>([
    ...data.attention.decide.map((d) => d.task.channelId),
    ...data.attention.unstuck.map((d) => d.channelId),
  ]);
  return {
    channel,
    channelPath,
    onScreen,
    switching,
    canAct,
    refreshing,
    stale,
    shownChannelName,
    directWith,
    shownDirect,
    channelAgents,
    focusedTask,
    workerAgent,
    onBoardPage,
    onPage,
    tabValue,
    screen,
    channelLevel,
    looking,
    pageAgent,
    inSettings,
    settingsSection,
    waiting,
    waitingIn,
  };
}
export type Screen = ReturnType<typeof screenOf>;
