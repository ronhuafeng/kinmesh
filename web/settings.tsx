import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { useRequest, value } from './api.js';
import { Field, Notice } from './forms.js';
import { Page } from './ui.js';

/** The team's name and the owner's password: the two things only you set. */
export function SettingsPage({
  data,
  onClose,
  onDone,
  onNotify,
}: {
  data: WorkspaceSnapshot;
  onClose: () => void;
  onDone: () => void;
  onNotify: (message: string) => void;
}) {
  const team = useRequest({ 400: 'Use 1–80 characters.' });
  const password = useRequest({
    400: 'Use 15–128 characters for the new password.',
    403: 'That isn’t your current password.',
    429: 'Too many tries. Wait a minute, then try again.',
  });
  return (
    <Page label="Settings" onClose={onClose}>
      <div className="page-body">
        <h2>Settings</h2>
        <form
          className="settings-form"
          aria-label="Team name"
          onSubmit={(event) => {
            event.preventDefault();
            const name = value(new FormData(event.currentTarget), 'name');
            void team
              .send('/api/team', { name: name.trim() }, 'PUT')
              .then((ok) => {
                if (ok === undefined) return;
                onNotify('Team renamed.');
                onDone();
              });
          }}
        >
          <h3>Team</h3>
          <Field label="Team name">
            <input
              name="name"
              required
              maxLength={80}
              autoComplete="organization"
              defaultValue={data.team.name}
            />
          </Field>
          <button type="submit" disabled={team.disabled}>
            {team.busy ? 'Saving…' : 'Save name'}
          </button>
          {team.error && <Notice>{team.error}</Notice>}
        </form>
        <form
          className="settings-form"
          aria-label="Password"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const fields = new FormData(form);
            void password
              .send('/api/me/password', {
                currentPassword: value(fields, 'currentPassword'),
                newPassword: value(fields, 'newPassword'),
              })
              .then((ok) => {
                if (ok === undefined) return;
                form.reset();
                onNotify('Password changed. Other sessions were signed out.');
              });
          }}
        >
          <h3>Password</h3>
          {/* Lets a password manager tie the new password to this account. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={data.human.username}
            readOnly
            hidden
          />
          <Field label="Current password">
            <input
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
            />
          </Field>
          <Field label="New password" hint="15–128 characters">
            <input
              name="newPassword"
              type="password"
              required
              minLength={15}
              maxLength={128}
              autoComplete="new-password"
            />
          </Field>
          <button type="submit" disabled={password.disabled}>
            {password.busy ? 'Changing…' : 'Change password'}
          </button>
          {password.error && <Notice>{password.error}</Notice>}
        </form>
      </div>
    </Page>
  );
}
