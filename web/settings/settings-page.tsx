import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Page } from '../shared/page.js';
import { SettingsList } from './settings-list.js';
import { sectionOf, FIRST } from './sections.js';
import { SettingsSection } from './settings-section.js';

/**
 * Settings as a page: on a wide screen the section beside the map, with no
 * title (the map says where you are); on a phone the map's list, or a
 * section under a bar that leads back to it.
 */
export function SettingsPage({
  section,
  phone,
  data,
  onSection,
  onClose,
  ...rest
}: {
  section: string;
  phone: boolean;
  data: WorkspaceSnapshot;
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
        <SettingsList onSelect={onSection} />
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
