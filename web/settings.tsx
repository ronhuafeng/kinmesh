import { PowerIcon } from './icons.js';
import { Page } from './ui.js';

/**
 * Your own page: signing out. Whose page it is shows in the sidebar, where
 * your row is highlighted; the team's name is the organization's, shown at
 * the top of the sidebar.
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
    <Page label="Settings" onClose={onClose} bar={false}>
      <div className="page-body you">
        <div className="you-sign-outs">
          {onSignOut && (
            <button type="button" className="you-sign-out" onClick={onSignOut}>
              <PowerIcon />
              Sign out
            </button>
          )}
          <button
            type="button"
            className="you-sign-out"
            onClick={onSignOutEverywhere}
          >
            <PowerIcon />
            Sign out everywhere
          </button>
        </div>
      </div>
    </Page>
  );
}
