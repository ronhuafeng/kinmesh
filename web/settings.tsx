import { useState } from 'react';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { useRequest, value } from './api.js';
import { Notice } from './forms.js';
import { ArrowIcon } from './icons.js';
import { Page } from './ui.js';

/**
 * Your own page: the two things only you set, as facts typed in place. Whose
 * page it is shows in the sidebar, where your row is highlighted. Each confirms with the round arrow once there is
 * something to confirm.
 */
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
  const [name, setName] = useState(data.team.name);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <Page label="Settings" onClose={onClose}>
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
        <form
          className="you-row"
          aria-label="Password"
          onSubmit={(event) => {
            event.preventDefault();
            void password
              .send('/api/me/password', {
                currentPassword: value(
                  new FormData(event.currentTarget),
                  'currentPassword',
                ),
                newPassword: next,
              })
              .then((ok) => {
                if (ok === undefined) return;
                setCurrent('');
                setNext('');
                onNotify('Password changed. Other sessions were signed out.');
              });
          }}
        >
          <span className="you-label" aria-hidden="true">
            Password
          </span>
          <span className="you-value you-stack">
            {/* Lets a password manager tie the new password to this account. */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={data.human.username}
              readOnly
              hidden
            />
            <input
              name="currentPassword"
              type="password"
              aria-label="Current password"
              placeholder="Current password"
              required
              autoComplete="current-password"
              value={current}
              onChange={(event) => {
                setCurrent(event.target.value);
                password.setError('');
              }}
            />
            <span className="you-value">
              <input
                name="newPassword"
                type="password"
                aria-label="New password"
                placeholder="New password · 15–128 characters"
                required
                minLength={15}
                maxLength={128}
                autoComplete="new-password"
                value={next}
                onChange={(event) => {
                  setNext(event.target.value);
                  password.setError('');
                }}
              />
              <button
                type="submit"
                className="icon-button confirm"
                aria-label="Change password"
                aria-busy={password.busy}
                disabled={password.disabled || current === '' || next === ''}
              >
                <ArrowIcon />
              </button>
            </span>
          </span>
          {password.error && <Notice>{password.error}</Notice>}
        </form>
      </div>
    </Page>
  );
}
