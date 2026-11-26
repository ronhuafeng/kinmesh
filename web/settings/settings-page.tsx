import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Files } from '../shared/files.js';
import { NotificationSettings } from './notification-settings.js';
import { sectionOf, COMING, FIRST } from './sections.js';
import {
  Planned,
  Appearance,
  ProfileSection,
  AccountSection,
  Shortcuts,
} from './personal-sections.js';
import { Members, Channels, Agents, Connections } from './team-sections.js';
import { Page } from '../shared/page.js';
import { SettingsList } from './settings-nav.js';

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
/**
 * Settings as a page: on a wide screen the section beside the map, with no
 * title (the map says where you are); on a phone the map's list, or a
 * section under a bar that leads back to it.
 */
export function SettingsPage({
  section,
  phone,
  data,
  sectionHref,
  onSection,
  onClose,
  ...rest
}: {
  section: string;
  phone: boolean;
  data: WorkspaceSnapshot;
  /** A section's address. */
  sectionHref: (id: string) => string;
  onSection: (id: string) => void;
  onClose: () => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  openChannel: (id: string) => void;
  openAgent: (id: string) => void;
  openMessage: (channelId: string, messageId: string) => void;
}) {
  if (phone && section === '')
    return (
      <Page label="设置" onClose={onClose} bar={false}>
        <SettingsList hrefOf={sectionHref} onSelect={onSection} />
      </Page>
    );
  const id = sectionOf(section) ? section : FIRST.personal;
  return (
    <Page
      label={sectionOf(id)?.label ?? '设置'}
      onClose={
        phone
          ? () => {
              onSection('');
            }
          : onClose
      }
      bar={phone ? undefined : false}
      className="settings-page"
    >
      <div className="page-body settings-body">
        <SettingsSection id={id} data={data} {...rest} />
      </div>
    </Page>
  );
}
