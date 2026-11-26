import { Auth } from './shell/auth.js';
import { Broken } from './shell/boundary.js';
import { Opening } from './shell/opening.js';
import { useAppBadge } from './shell/use-app-badge.js';
import { useAvatarImages } from './shell/use-avatar-images.js';
import { useLanding } from './shell/use-landing.js';
import { useNotices } from './shell/use-notices.js';
import { usePlace } from './shell/use-place.js';
import { usePush } from './shell/use-push.js';
import { useShared } from './shell/use-shared.js';
import { useShortcuts } from './shell/use-shortcuts.js';
import { useSidebar } from './shell/use-sidebar.js';
import { useTitle } from './shell/use-title.js';
import { useWorkspace } from './shell/use-workspace.js';
import { Workspace } from './shell/workspace.js';
import { usePhone } from './shared/screen-size.js';

/**
 * The app: where you are, the live workspace for it and what goes with it,
 * composed. It keeps nothing itself; each part owns its state.
 */
export function App() {
  const place = usePlace();
  const phone = usePhone();
  const workspace = useWorkspace(place);
  const notices = useNotices(workspace.data);
  const shared = useShared();
  // On a tablet the sidebar folds away or slides in; a new place closes it.
  const sidebar = useSidebar(place.url);
  const avatarImages = useAvatarImages(workspace.data);
  useLanding(workspace.data, phone, place);
  useShortcuts(phone, place);
  useAppBadge(workspace.data, workspace.status === 'signedout');
  usePush(workspace.data);
  useTitle(workspace.status === 'signedout' ? null : workspace.data, place);
  if (workspace.unreadable) return <Broken />;
  if (workspace.status === 'signedout')
    return <Auth denied={workspace.denied} />;
  if (!workspace.data)
    return (
      <Opening failed={workspace.unreachable} onRetry={workspace.refreshNow} />
    );
  return (
    <Workspace
      data={workspace.data}
      place={place}
      workspace={workspace}
      notices={notices}
      shared={shared}
      sidebar={sidebar}
      phone={phone}
      avatarImages={avatarImages}
    />
  );
}
