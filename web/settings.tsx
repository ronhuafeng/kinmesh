import { useContext, useEffect, useState } from 'react';
import type { NotifyLevel } from '../src/domain/notify.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { MutationPermission, useRequest } from './api.js';
import { Notice } from './forms.js';
import { PowerIcon } from './icons.js';
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
/** Whether this is an iPhone or iPad not opened from its Home Screen. */
const iosInBrowser = () =>
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
  !window.matchMedia('(display-mode: standalone)').matches;
/**
 * Where this browser stands: it can't be notified, it said no, notifications
 * are off here, or on (and can be tried). Read once the page opens.
 */
type Here = 'unknown' | 'unsupported' | 'home-screen' | 'denied' | 'off' | 'on';
async function readHere(): Promise<Here> {
  if (!pushSupported()) return iosInBrowser() ? 'home-screen' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return (await currentSubscription()) ? 'on' : 'off';
}
/**
 * What notifies you, on every browser you turned notifications on in, and
 * where this browser stands. Choosing to be notified, here, turns them on
 * here too.
 */
function Notifications({ level }: { level: NotifyLevel }) {
  const action = useRequest({
    410: '这台设备已不再接收通知，请重新开启。',
    502: '推送服务暂时连不上，通知没有发出。',
  });
  const [here, setHere] = useState<Here>('unknown');
  // A test sent just now says so on its button for a moment.
  const [tried, setTried] = useState(false);
  useEffect(() => {
    void readHere().then(setHere, () => {
      setHere('unsupported');
    });
  }, []);
  useEffect(() => {
    if (!tried) return;
    const timer = setTimeout(() => {
      setTried(false);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [tried]);
  const turnOn = async () => {
    const on = await action.run(subscribe);
    if (on !== undefined) setHere(on ? 'on' : await readHere());
  };
  const turnOff = async () => {
    if ((await action.run(unsubscribe)) !== undefined) setHere('off');
  };
  const test = async () => {
    const endpoint = (await currentSubscription())?.endpoint;
    if (!endpoint) {
      setHere('off');
      return;
    }
    const sent = await action.send('/api/push/test', { endpoint });
    if (sent !== undefined) setTried(true);
    else setHere(await readHere());
  };
  const choose = async (next: NotifyLevel) => {
    if (next === level) return;
    const sent = await action.send('/api/me/notify', { level: next }, 'PUT');
    if (sent !== undefined && next !== 'off' && here === 'off') await turnOn();
  };
  return (
    <>
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
      {level !== 'off' && (
        <div className="you-row">
          <span>此设备</span>
          <span className="you-row-end">
            {here === 'on' ? (
              <>
                <button
                  type="button"
                  className="link-button"
                  disabled={action.disabled}
                  onClick={() => void test()}
                >
                  {tried ? '已发送' : '发送测试通知'}
                </button>
                <button
                  type="button"
                  className="link-button"
                  disabled={action.disabled}
                  onClick={() => void turnOff()}
                >
                  停止接收
                </button>
              </>
            ) : here === 'off' ? (
              <button
                type="button"
                className="link-button"
                disabled={action.disabled}
                onClick={() => void turnOn()}
              >
                开启
              </button>
            ) : here === 'denied' ? (
              <span className="muted">
                浏览器拦截了通知，可在网站设置中允许
              </span>
            ) : here === 'home-screen' ? (
              <span className="muted">添加到主屏幕后可以接收通知</span>
            ) : here === 'unsupported' ? (
              <span className="muted">这个浏览器收不到通知</span>
            ) : null}
          </span>
        </div>
      )}
      {action.error && <Notice>{action.error}</Notice>}
    </>
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
        <section className="you-notify" aria-label="通知">
          <Notifications level={data.notify} />
          {data.notify !== 'off' && <Pause until={data.pausedUntil} />}
          <Muted data={data} />
        </section>
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
