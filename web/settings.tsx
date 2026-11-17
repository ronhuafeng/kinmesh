import { useContext, useEffect, useState } from 'react';
import type { NotifyLevel } from '../src/domain/notify.js';
import { MutationPermission, useRequest } from './api.js';
import { Notice } from './forms.js';
import { BellIcon, BellOffIcon, PowerIcon } from './icons.js';
import {
  currentSubscription,
  pushSupported,
  subscribe,
  unsubscribe,
} from './push.js';
import { Page } from './ui.js';

const LEVELS: { level: NotifyLevel; label: string }[] = [
  { level: 'all', label: '全部' },
  { level: 'mine', label: '与我有关' },
  { level: 'off', label: '关闭' },
];
/**
 * What notifies you, on every browser you turned notifications on in, and
 * whether this browser is one of them. Choosing to be notified, here, turns
 * them on here too; a browser that has said no shows no way to.
 */
function Notifications({ level }: { level: NotifyLevel }) {
  const action = useRequest();
  // This browser: on, off, or not yet known.
  const [here, setHere] = useState<boolean | null>(null);
  useEffect(() => {
    void currentSubscription().then(
      (subscription) => {
        setHere(subscription !== null);
      },
      () => {
        setHere(false);
      },
    );
  }, []);
  const possible =
    pushSupported() && Notification.permission !== 'denied' && here !== null;
  const turnOn = async () => {
    const on = await action.run(subscribe);
    if (on !== undefined) setHere(on);
  };
  const choose = async (next: NotifyLevel) => {
    if (next === level) return;
    const sent = await action.send('/api/me/notify', { level: next }, 'PUT');
    if (sent !== undefined && next !== 'off' && possible && !here)
      await turnOn();
  };
  return (
    <div className="you-notify">
      <div className="you-row">
        <span id="notify-label">通知</span>
        <div className="segmented" role="group" aria-labelledby="notify-label">
          {LEVELS.map((l) => (
            <button
              key={l.level}
              type="button"
              aria-pressed={level === l.level}
              disabled={action.disabled}
              onClick={() => void choose(l.level)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      {possible && level !== 'off' && (
        <button
          type="button"
          className="you-action"
          disabled={action.disabled}
          onClick={() =>
            void (here
              ? action.run(unsubscribe).then((done) => {
                  if (done !== undefined) setHere(false);
                })
              : turnOn())
          }
        >
          {here ? <BellOffIcon size={20} /> : <BellIcon size={20} />}
          {here ? '此设备不再接收通知' : '在此设备上接收通知'}
        </button>
      )}
      {action.error && <Notice>{action.error}</Notice>}
    </div>
  );
}
/**
 * Your own page, opened from your tile on Team (a phone's You tab): what
 * notifies you, and signing out, here or everywhere. The team's name is the
 * organization's, shown at the top of the sidebar.
 */
export function SettingsPage({
  notify,
  onClose,
  onSignOut,
  onSignOutEverywhere,
}: {
  notify: NotifyLevel;
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
        <Notifications level={notify} />
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
