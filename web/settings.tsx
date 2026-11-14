import { useState } from 'react';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { useRequest } from './api.js';
import { Notice } from './forms.js';
import { ArrowIcon, PowerIcon } from './icons.js';
import { Page } from './ui.js';

/**
 * Your own page: the team name, typed in place, and signing out. Whose
 * page it is shows in the sidebar, where your row is highlighted. Each confirms with the round arrow once there is
 * something to confirm.
 */
export function SettingsPage({
  data,
  onClose,
  onDone,
  onNotify,
  onSignOut,
  onSignOutEverywhere,
}: {
  data: WorkspaceSnapshot;
  onClose: () => void;
  onDone: () => void;
  onNotify: (message: string) => void;
  /** On a phone, where the header's power icon is not shown. */
  onSignOut?: () => void;
  /** Ends every session of yours, on every device, this one included. */
  onSignOutEverywhere: () => void;
}) {
  const team = useRequest({ 400: 'Use 1–80 characters.' });
  const [name, setName] = useState(data.team.name);
  return (
    <Page label="Settings" onClose={onClose} bar={false}>
      <div className="page-body you">
        <form
          className="you-row"
          aria-label="Team name"
          onSubmit={(event) => {
            event.preventDefault();
            void team
              .send('/api/team', { name: name.trim() }, 'PUT')
              .then((ok) => {
                if (ok === undefined) return;
                onNotify('Team renamed.');
                onDone();
              });
          }}
        >
          <span className="you-label" aria-hidden="true">
            Team
          </span>
          <span className="you-value">
            <input
              name="name"
              aria-label="Team name"
              required
              maxLength={80}
              autoComplete="organization"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                team.setError('');
              }}
            />
            <button
              type="submit"
              className="icon-button confirm"
              aria-label="Save name"
              aria-busy={team.busy}
              disabled={
                team.disabled ||
                name.trim() === '' ||
                name.trim() === data.team.name
              }
            >
              <ArrowIcon />
            </button>
          </span>
          {team.error && <Notice>{team.error}</Notice>}
        </form>
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
