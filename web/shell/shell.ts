import { createContext, useContext } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { actionsOf } from './actions.js';
import { commandsOf } from './commands.js';
import { remoteSearch } from './remote-search.js';
import { screenOf } from './screen.js';
import type { Notices } from './use-notices.js';
import type { Place } from './use-place.js';
import type { useShared } from './use-shared.js';
import type { useSidebar } from './use-sidebar.js';
import type { Workspace } from './use-workspace.js';

/**
 * Everything the shell's parts read: where you are, what the screen shows,
 * what can be done, and the snapshot it all comes from. Built once per
 * render by `Workspace`; nothing in it is kept.
 */
export function shellOf(
  data: WorkspaceSnapshot,
  place: Place,
  workspace: Workspace,
  notices: Notices,
  shared: ReturnType<typeof useShared>,
  sidebar: ReturnType<typeof useSidebar>,
  phone: boolean,
) {
  const screen = screenOf(data, place, workspace, phone, shared.shared);
  const actions = actionsOf(data, place, screen, workspace, notices.notify);
  return {
    data,
    phone,
    sidebar,
    ...place,
    ...screen,
    ...actions,
    ...shared,
    ...notices,
    refresh: workspace.refresh,
    refreshNow: workspace.refreshNow,
    loadedPlace: workspace.loadedPlace,
    commands: commandsOf(data, place, screen, actions, workspace.refreshNow),
    remote: remoteSearch(data, actions.openMessageIn),
  };
}
export type Shell = ReturnType<typeof shellOf>;
export const ShellContext = createContext<Shell | null>(null);
/** The shell, inside `Workspace`. */
export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (shell === null) throw new Error('useShell outside Workspace');
  return shell;
}
