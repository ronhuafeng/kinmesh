import { useContext, useEffect, useState } from 'react';
import type { NotifyLevel } from '../src/domain/notify.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { MutationPermission, useRequest } from './api.js';
import { Notice } from './forms.js';
import { BellIcon, BellOffIcon, PowerIcon } from './icons.js';
import {
  currentSubscription,
  pushSupported,
  subscribe,
  unsubscribe,
} from './push.js';
import { Avatar, ChannelIcon, Page } from './ui.js';

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
/** Eight in the morning after now, by this browser's clock. */
function tomorrowMorning(now: Date) {
  const at = new Date(now);
  at.setDate(at.getDate() + (now.getHours() < 8 ? 0 : 1));
  at.setHours(8, 0, 0, 0);
  return at;
}
/**
 * Pausing: for an hour or until the morning, and it ends by itself. The
 * choice shown is the pause in force, told by when it ends.
 */
function Pause({ until }: { until: string | null }) {
  const action = useRequest();
  const ends = until === null ? null : new Date(until);
  const now = new Date();
  const current =
    ends === null || ends <= now
      ? 'none'
      : ends.getHours() === 8 && ends.getMinutes() === 0
        ? 'morning'
        : 'hour';
  const choose = (next: 'none' | 'hour' | 'morning') => {
    if (next === current) return;
    const at =
      next === 'none'
        ? null
        : next === 'hour'
          ? new Date(Date.now() + 60 * 60 * 1000)
          : tomorrowMorning(new Date());
    void action.send(
      '/api/me/pause',
      { until: at === null ? null : at.toISOString() },
      'PUT',
    );
  };
  const options = [
    { id: 'none', label: '不暂停' },
    { id: 'hour', label: '1 小时' },
    { id: 'morning', label: '到明早' },
  ] as const;
  return (
    <>
      <div className="you-row">
        <span id="pause-label">暂停通知</span>
        <div className="segmented" role="group" aria-labelledby="pause-label">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={current === o.id}
              disabled={action.disabled}
              {...(current === o.id && ends
                ? { title: '到 ' + ends.toLocaleString('zh-CN') }
                : {})}
              onClick={() => {
                choose(o.id);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/** What you muted, each one click from undoing it. */
function Muted({ data }: { data: WorkspaceSnapshot }) {
  const action = useRequest();
  const team = '/api/teams/' + data.team.id;
  const rows = [
    ...data.muted.channels.flatMap((id) => {
      const channel = data.channels.items.find((c) => c.id === id);
      return channel
        ? [
            {
              key: id,
              face: <ChannelIcon id={id} name={channel.name} />,
              name: channel.name,
              path: `${team}/channels/${id}/mute`,
            },
          ]
        : [];
    }),
    ...data.muted.agents.flatMap((id) => {
      const agent = data.agents.find((a) => a.id === id);
      return agent
        ? [
            {
              key: id,
              face: <Avatar kind="agent" name={agent.name} id={id} />,
              name: agent.name,
              path: `${team}/agents/${id}/mute`,
            },
          ]
        : [];
    }),
  ];
  if (rows.length === 0) return null;
  return (
    <>
      <ul className="you-muted" aria-label="已静音">
        {rows.map((row) => (
          <li key={row.key}>
            {row.face}
            <span>{row.name}</span>
            <button
              type="button"
              className="link-button"
              disabled={action.disabled}
              onClick={() => void action.send(row.path, { muted: false })}
            >
              取消静音
            </button>
          </li>
        ))}
      </ul>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/**
 * Your own page, opened from your tile on Team (a phone's You tab): what
 * notifies you, and signing out, here or everywhere. The team's name is the
 * organization's, shown at the top of the sidebar.
 */
export function SettingsPage({
  data,
  onClose,
  onSignOut,
  onSignOutEverywhere,
}: {
  data: WorkspaceSnapshot;
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
        <Notifications level={data.notify} />
        {data.notify !== 'off' && <Pause until={data.pausedUntil} />}
        <Muted data={data} />
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
