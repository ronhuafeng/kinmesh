import { useContext } from 'react';
import { MutationPermission } from './api.js';
import { PowerIcon } from './icons.js';
import { Page } from './ui.js';

/**
 * Your own page, opened from your tile on Team (a phone's You tab): signing
 * out, here or everywhere. The team's name is the organization's, shown at
 * the top of the sidebar.
 */
export function SettingsPage({
  onClose,
  onSignOut,
  onSignOutEverywhere,
}: {
  onClose: () => void;
  onSignOut: () => void;
  /** Ends every session of yours, on every device, this one included. */
  onSignOutEverywhere: () => void;
}) {
  // Out of reach, signing out waits like every other action.
  const permitted = useContext(MutationPermission);
  return (
    <Page label="设置" onClose={onClose} bar={false}>
      <div className="page-body you">
        <div className="you-sign-outs">
          <button
            type="button"
            className="you-sign-out"
            disabled={!permitted}
            onClick={onSignOut}
          >
            <PowerIcon size={20} />
            退出登录
          </button>
          <button
            type="button"
            className="you-sign-out"
            disabled={!permitted}
            onClick={onSignOutEverywhere}
          >
            <PowerIcon size={20} />
            在所有设备上退出登录
          </button>
        </div>
      </div>
    </Page>
  );
}
