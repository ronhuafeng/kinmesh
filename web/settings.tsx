import { useContext, useState } from 'react';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, HttpError, MutationPermission } from './api.js';
import { Field, Notice } from './forms.js';
import { Drawer } from './ui.js';

/** Send one JSON request; say what went wrong in the person's terms. */
function useSubmit(messages: Partial<Record<number, string>>) {
  const permitted = useContext(MutationPermission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(path: string, method: 'POST' | 'PUT', body: unknown) {
    if (!permitted || busy) return false;
    setBusy(true);
    setError('');
    try {
      await api(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return true;
    } catch (cause) {
      setError(
        (cause instanceof HttpError ? messages[cause.status] : undefined) ??
          'That did not go through. Nothing was changed; try again.',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { submit, busy, error, disabled: !permitted || busy };
}
const read = (form: HTMLFormElement, key: string) => {
  const value = new FormData(form).get(key);
  return typeof value === 'string' ? value : '';
};
/** The team's name and the owner's password: the two things only you set. */
export function SettingsDrawer({
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
  const team = useSubmit({ 400: 'Use 1–80 characters.' });
  const password = useSubmit({
    400: 'Use 15–128 characters for the new password.',
    403: 'That isn’t your current password.',
    429: 'Too many tries. Wait a minute, then try again.',
  });
  return (
    <Drawer label="Settings" onClose={onClose} className="settings-drawer">
      <div className="drawer-body">
        <h2>Settings</h2>
        <form
          className="settings-form"
          aria-label="Team name"
          onSubmit={(event) => {
            event.preventDefault();
            const name = read(event.currentTarget, 'name').trim();
            void team.submit('/api/team', 'PUT', { name }).then((ok) => {
              if (!ok) return;
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
            void password
              .submit('/api/me/password', 'POST', {
                currentPassword: read(form, 'currentPassword'),
                newPassword: read(form, 'newPassword'),
              })
              .then((ok) => {
                if (!ok) return;
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
    </Drawer>
  );
}
