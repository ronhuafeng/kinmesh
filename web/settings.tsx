import { useContext, useEffect, useId, useState } from 'react';
import {
  type NotificationKind,
  type NotifyHours,
} from '../src/domain/notify.js';
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
import { Avatar, ChannelIcon, Switch } from './ui.js';

/** What can notify you, most pressing first, as your page lists it. */
const KINDS: { kind: NotificationKind; label: string }[] = [
  { kind: 'decide', label: '等我验收' },
  { kind: 'task', label: '交给我的任务' },
  { kind: 'blocked', label: '我的请求卡住了' },
  { kind: 'reply', label: '智能体回复我' },
  { kind: 'mention', label: '@我' },
  { kind: 'message', label: '频道里的其他消息' },
];
/**
 * A row with its choice at the end: the segmented control. `title` says on
 * hover what the row does, when its label alone may not.
 */
export function ChoiceRow<T extends string>({
  label,
  title,
  options,
  value,
  disabled,
  onChoose,
}: {
  label: string;
  title?: string;
  options: readonly { id: T; label: string; title?: string }[];
  value: T;
  disabled: boolean;
  onChoose: (id: T) => void;
}) {
  const id = useId();
  return (
    <div className="you-row">
      <span id={id} {...(title ? { title } : {})}>
        {label}
      </span>
      <div className="segmented" role="group" aria-labelledby={id}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={value === o.id}
            disabled={disabled}
            {...(o.title ? { title: o.title } : {})}
            onClick={() => {
              if (o.id !== value) onChoose(o.id);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
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
 * What can notify you, kind by kind: a switch each, flipped at once and
 * sent; the workspace then shows what the hub kept.
 */
function Kinds({ kinds }: { kinds: readonly NotificationKind[] }) {
  const action = useRequest();
  const [shown, setShown] = useState<readonly NotificationKind[]>(kinds);
  useEffect(() => {
    setShown(kinds);
  }, [kinds]);
  const base = useId();
  const flip = (kind: NotificationKind, on: boolean) => {
    const next = KINDS.map((k) => k.kind).filter((k) =>
      k === kind ? on : shown.includes(k),
    );
    setShown(next);
    void action.send('/api/me/notify', { kinds: next }, 'PUT').then((sent) => {
      if (sent === undefined) setShown(kinds);
    });
  };
  return (
    <>
      <div className="you-rows">
        {KINDS.map(({ kind, label }) => (
          <label className="you-row" key={kind}>
            <span id={base + kind}>{label}</span>
            <Switch
              on={shown.includes(kind)}
              labelledBy={base + kind}
              disabled={action.disabled}
              onChange={(on) => {
                flip(kind, on);
              }}
            />
          </label>
        ))}
      </div>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/**
 * Where this browser stands: on (and can be tried), off, or why it can't
 * be. Turned on from here, the browser asks once.
 */
function ThisDevice() {
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
  return (
    <>
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
            <span className="muted">浏览器拦截了通知，可在网站设置中允许</span>
          ) : here === 'home-screen' ? (
            <span className="muted">添加到主屏幕后可以接收通知</span>
          ) : here === 'unsupported' ? (
            <span className="muted">这个浏览器收不到通知</span>
          ) : null}
        </span>
      </div>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/** What stays unread this long also goes to you in Feishu, from the bot. */
function Forward({ minutes }: { minutes: number | null }) {
  const action = useRequest();
  const value = minutes === null ? 'never' : String(minutes);
  return (
    <>
      <ChoiceRow
        label="转发到飞书"
        title="通知这段时间里还没读，就由飞书机器人私信你"
        options={[
          { id: 'never', label: '不转发' },
          { id: '5', label: '5 分钟' },
          { id: '15', label: '15 分钟' },
          { id: '60', label: '1 小时' },
        ]}
        value={value}
        disabled={action.disabled}
        onChoose={(id) =>
          void action.send(
            '/api/me/forward',
            { minutes: id === 'never' ? null : Number(id) },
            'PUT',
          )
        }
      />
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/** "09:00" for a minute of the day. */
const clock = (minute: number) =>
  String(Math.floor(minute / 60)).padStart(2, '0') +
  ':' +
  String(minute % 60).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, hour) => hour * 60);
/** An hour of the day, chosen in place: its time, underlined, and a list. */
function HourPicker({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (minute: number) => void;
}) {
  return (
    <select
      className="hour-picker"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
    >
      {HOURS.map((minute) => (
        <option key={minute} value={minute}>
          {clock(minute)}
        </option>
      ))}
    </select>
  );
}
/**
 * When notifications may reach you: any time, or between two hours, every
 * day or on weekdays, in this browser's time zone. Outside them they wait.
 */
function Hours({ hours }: { hours: NotifyHours | null }) {
  const action = useRequest();
  const save = (next: NotifyHours | null) =>
    void action.send('/api/me/hours', { hours: next }, 'PUT');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <>
      <ChoiceRow
        label="通知时段"
        title="时段之外的通知会等到时段开始再发"
        options={[
          { id: 'always', label: '全天' },
          { id: 'between', label: '自定' },
        ]}
        value={hours === null ? 'always' : 'between'}
        disabled={action.disabled}
        onChoose={(id) => {
          save(
            id === 'always'
              ? null
              : { from: 9 * 60, to: 21 * 60, weekdays: false, timeZone },
          );
        }}
      />
      {hours !== null && (
        <div className="you-row you-row-sub">
          <span className="you-hours">
            <HourPicker
              label="开始"
              value={hours.from}
              disabled={action.disabled}
              onChange={(from) => {
                if (from !== hours.to) save({ ...hours, from, timeZone });
              }}
            />
            <span aria-hidden="true">–</span>
            <HourPicker
              label="结束"
              value={hours.to}
              disabled={action.disabled}
              onChange={(to) => {
                if (to !== hours.from) save({ ...hours, to, timeZone });
              }}
            />
          </span>
          <div className="segmented" role="group" aria-label="哪些天">
            {(
              [
                { weekdays: false, label: '每天' },
                { weekdays: true, label: '工作日' },
              ] as const
            ).map((o) => (
              <button
                key={o.label}
                type="button"
                aria-pressed={hours.weekdays === o.weekdays}
                disabled={action.disabled}
                onClick={() => {
                  if (hours.weekdays !== o.weekdays)
                    save({ ...hours, weekdays: o.weekdays, timeZone });
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/** Eight in the morning after now, by this browser's clock. */
export function tomorrowMorning(now: Date) {
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
  const current =
    ends === null || ends <= new Date()
      ? 'none'
      : ends.getHours() === 8 && ends.getMinutes() === 0
        ? 'morning'
        : 'hour';
  const endsAt =
    ends && current !== 'none'
      ? { title: '到 ' + ends.toLocaleString('zh-CN') }
      : {};
  return (
    <>
      <ChoiceRow
        label="暂停通知"
        options={[
          { id: 'none', label: '不暂停' },
          {
            id: 'hour',
            label: '1 小时',
            ...(current === 'hour' ? endsAt : {}),
          },
          {
            id: 'morning',
            label: '到明早',
            ...(current === 'morning' ? endsAt : {}),
          },
        ]}
        value={current}
        disabled={action.disabled}
        onChoose={(next) => {
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
        }}
      />
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
 * 通知 in settings: what can notify you, where it reaches you, when, and
 * what you muted, each a run of rows.
 */
export function NotificationSettings({ data }: { data: WorkspaceSnapshot }) {
  return (
    <section className="you-notify" aria-label="通知">
      <Kinds kinds={data.notify} />
      {data.notify.length > 0 && (
        <>
          <div className="you-rows">
            <ThisDevice />
            <Forward minutes={data.forwardAfter} />
          </div>
          <div className="you-rows">
            <Hours hours={data.hours} />
            <Pause until={data.pausedUntil} />
          </div>
        </>
      )}
      <Muted data={data} />
    </section>
  );
}
/** Signing out, here or everywhere: quiet rows in the danger colour. */
export function SignOuts({
  onSignOut,
  onSignOutEverywhere,
}: {
  onSignOut: () => void;
  /** Ends every session of yours, on every device, this one included. */
  onSignOutEverywhere: () => void;
}) {
  // Out of reach, signing out waits like every other action.
  const permitted = useContext(MutationPermission);
  return (
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
  );
}
