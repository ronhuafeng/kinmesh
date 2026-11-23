import { createContext, useContext } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { actionsOf } from './actions.js';
import { commandsOf, remoteSearch } from './search-commands.js';
import { screenOf } from './screen.js';
import type { Notices } from './use-notices.js';
import type { Place } from './use-place.js';
import type { useShared } from './use-shared.js';
import type { useSidebar } from './use-sidebar.js';
import type { Workspace } from './use-workspace.js';

/**
 * What the shell's parts read, in three parts so each says what it depends
 * on: where you are and how to go elsewhere (`useNavigation`), what the
 * screen shows (`useScreen`), and what can be done (`useActions`). Built
 * once per render by `Workspace`; nothing in them is kept.
 */
export function contextsOf(
  data: WorkspaceSnapshot,
  place: Place,
  workspace: Workspace,
  notices: Notices,
  shared: ReturnType<typeof useShared>,
  sidebar: ReturnType<typeof useSidebar>,
  phone: boolean,
) {
  const shown = screenOf(data, place, workspace, phone, shared.shared);
  const actions = actionsOf(data, place, shown, workspace, notices.notify);
  return {
    navigation: place,
    screen: {
      data,
      phone,
      sidebar,
      loadedPlace: workspace.loadedPlace,
      ...shown,
    },
    actions: {
      ...actions,
      ...notices,
      ...shared,
      refresh: workspace.refresh,
      refreshNow: workspace.refreshNow,
      commands: commandsOf(data, place, shown, actions, workspace.refreshNow),
      remote: remoteSearch(data, actions.openMessageIn),
    },
  };
}
type Contexts = ReturnType<typeof contextsOf>;
export const NavigationContext = createContext<Contexts['navigation'] | null>(
  null,
);
export const ScreenContext = createContext<Contexts['screen'] | null>(null);
export const ActionsContext = createContext<Contexts['actions'] | null>(null);
const needed = <T>(value: T | null): T => {
  if (value === null) throw new Error('Outside Workspace');
  return value;
};
/** Where you are, and how to go elsewhere. */
export const useNavigation = () => needed(useContext(NavigationContext));
/** What the screen shows: the snapshot and what follows from it. */
export const useScreen = () => needed(useContext(ScreenContext));
/** What can be done: actions that reach the hub, notices, search, sharing. */
export const useActions = () => needed(useContext(ActionsContext));
