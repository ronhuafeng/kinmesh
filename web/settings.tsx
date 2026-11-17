import { PowerIcon } from './icons.js';
import { Page } from './ui.js';

/**
 * Your own page, opened from your tile on Team (a phone's You tab): signing
 * out. The team's name is the organization's, shown at the top of the
 * sidebar.
 */
export function SettingsPage({
  onClose,
  onSignOut,
  onSignOutEverywhere,
}: {
  onClose: () => void;
  /** On a phone, where the header's power icon is not shown. */
  onSignOut?: () => void;
  /** Ends every session of yours, on every device, this one included. */
  onSignOutEverywhere: () => void;
}) {
  return (
    <Page label="设置" onClose={onClose} bar={false}>
      <div className="page-body you">
        <div className="you-sign-outs">
          {onSignOut && (
            <button type="button" className="you-sign-out" onClick={onSignOut}>
              <PowerIcon />
              退出登录
            </button>
          )}
          <button
            type="button"
            className="you-sign-out"
            onClick={onSignOutEverywhere}
          >
            <PowerIcon />
            在所有设备上退出登录
          </button>
        </div>
      </div>
    </Page>
  );
}
