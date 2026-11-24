import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { MutationPermission, Offline } from '../shared/api.js';
import { AvatarImages } from '../shared/faces.js';
import { LiveContext } from '../shared/live.js';
import { MainArea } from './main-area.js';
import { PhoneTabs } from './phone-tabs.js';
import {
  ActionsContext,
  NavigationContext,
  ScreenContext,
  contextsOf,
} from './contexts.js';
import { Sidebar } from './sidebar.js';
import { Toasts } from './toasts.js';
import type { Notices } from './use-notices.js';
import type { Place } from './use-place.js';
import type { useShared } from './use-shared.js';
import type { useSidebar } from './use-sidebar.js';
import type { Workspace as Live } from './use-workspace.js';

/**
 * The workspace on screen: the sidebar, the main area, a phone's tabs and
 * the toasts, under what they share — whether you can act, the live reads
 * and everyone's pictures.
 */
export function Workspace({
  data,
  place,
  workspace,
  notices,
  shared,
  sidebar,
  phone,
  avatarImages,
}: {
  data: WorkspaceSnapshot;
  place: Place;
  workspace: Live;
  notices: Notices;
  shared: ReturnType<typeof useShared>;
  sidebar: ReturnType<typeof useSidebar>;
  phone: boolean;
  avatarImages: ReadonlyMap<string, string>;
}) {
  const { navigation, screen, actions } = contextsOf(
    data,
    place,
    workspace,
    notices,
    shared,
    sidebar,
    phone,
  );
  return (
    <NavigationContext.Provider value={navigation}>
      <ScreenContext.Provider value={screen}>
        <ActionsContext.Provider value={actions}>
          <MutationPermission value={screen.canAct}>
            <LiveContext.Provider value={workspace.liveReads}>
              <AvatarImages.Provider value={avatarImages}>
                <Offline value={!screen.canAct && !screen.switching}>
                  <div
                    className="workspace-shell"
                    data-screen={screen.screen}
                    data-sidebar={sidebar.state}
                    data-sidebar-moving={sidebar.moving ? 'true' : undefined}
                  >
                    <Sidebar />
                    <MainArea />
                    <PhoneTabs />
                    <Toasts />
                  </div>
                </Offline>
              </AvatarImages.Provider>
            </LiveContext.Provider>
          </MutationPermission>
        </ActionsContext.Provider>
      </ScreenContext.Provider>
    </NavigationContext.Provider>
  );
}
