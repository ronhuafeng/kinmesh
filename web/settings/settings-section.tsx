import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Files } from '../shared/files.js';
import { NotificationSettings } from './notification-settings.js';
import { sectionOf, COMING } from './sections.js';
import { Planned } from './planned.js';
import { Appearance } from './appearance.js';
import { ProfileSection } from './profile-section.js';
import { AccountSection } from './account-section.js';
import { Shortcuts } from './shortcuts.js';
import { Members } from './members.js';
import { Channels } from './channels.js';
import { Agents } from './agents.js';
import { Connections } from './connections.js';

/** The section a settings address names, as its page shows it. */
export function SettingsSection({
  id,
  data,
  onSignOut,
  onSignOutEverywhere,
  openChannel,
  openAgent,
  openMessage,
}: {
  id: string;
  data: WorkspaceSnapshot;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  openChannel: (id: string) => void;
  openAgent: (id: string) => void;
  openMessage: (channelId: string, messageId: string) => void;
}) {
  const section = sectionOf(id);
  if (!section) return null;
  if (section.planned || section.id === COMING.id) return <Planned />;
  switch (section.id) {
    case 'notifications':
      return <NotificationSettings data={data} />;
    case 'appearance':
      return <Appearance />;
    case 'profile':
      return <ProfileSection data={data} />;
    case 'account':
      return (
        <AccountSection
          onSignOut={onSignOut}
          onSignOutEverywhere={onSignOutEverywhere}
        />
      );
    case 'shortcuts':
      return <Shortcuts />;
    case 'members':
      return <Members data={data} />;
    case 'channels':
      return <Channels data={data} openChannel={openChannel} />;
    case 'agents':
      return <Agents data={data} openAgent={openAgent} />;
    case 'connections':
      return <Connections data={data} />;
    case 'files':
      return <Files data={data} openMessage={openMessage} />;
    default:
      return null;
  }
}
