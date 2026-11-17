import { useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, useRequest } from './api.js';
import { Notice } from './forms.js';
import { BackIcon, SettingsIcons } from './icons.js';
import { ChoiceRow, NotificationSettings, SignOuts } from './settings.js';
import { MODE_NAMES, t3Where, useT3 } from './setup.js';
import { applyTheme, readTheme, type Theme } from './theme.js';
import {
  Avatar,
  ChannelIcon,
  Page,
  Presence,
  ago,
  workerConnected,
} from './ui.js';

/**
 * The settings map, designed for the product Kinmesh is becoming: every
 * section it will have, in two groups, yours and the team's. A live one has
 * its page; a planned one shows the rows it will hold, quietly, and says so.
 */
type Icon = (typeof SettingsIcons)[keyof typeof SettingsIcons];
interface Section {
  id: string;
  group: 'personal' | 'team';
  label: string;
  icon: Icon;
  /** Not built yet: the rows it will hold. */
  planned?: string[];
}
export const SECTIONS: readonly Section[] = [
  {
    id: 'notifications',
    group: 'personal',
    label: '通知',
    icon: SettingsIcons.bell,
  },
  {
    id: 'assistant',
    group: 'personal',
    label: '我的助理',
    icon: SettingsIcons.sparkles,
    planned: ['分拣收件箱', '晨间简报', '起草回复', '它不做的决定'],
  },
  {
    id: 'appearance',
    group: 'personal',
    label: '外观',
    icon: SettingsIcons.appearance,
  },
  {
    id: 'profile',
    group: 'personal',
    label: '个人资料',
    icon: SettingsIcons.person,
  },
  {
    id: 'account',
    group: 'personal',
    label: '账户与设备',
    icon: SettingsIcons.devices,
  },
  {
    id: 'shortcuts',
    group: 'personal',
    label: '快捷键',
    icon: SettingsIcons.keyboard,
  },
  { id: 'members', group: 'team', label: '成员', icon: SettingsIcons.users },
  { id: 'channels', group: 'team', label: '频道', icon: SettingsIcons.hash },
  { id: 'agents', group: 'team', label: '智能体', icon: SettingsIcons.bot },
  {
    id: 'rules',
    group: 'team',
    label: '规则',
    icon: SettingsIcons.scale,
    planned: ['何时需要人评审', '各频道的运行方式', '谁能把工作交给智能体'],
  },
  { id: 'connections', group: 'team', label: '连接', icon: SettingsIcons.plug },
  {
    id: 'integrations',
    group: 'team',
    label: '集成',
    icon: SettingsIcons.puzzle,
    planned: ['GitHub', '日历', 'Webhooks', 'API 令牌'],
  },
  {
    id: 'files',
    group: 'team',
    label: '文件与存储',
    icon: SettingsIcons.folder,
    planned: ['附件', '存储用量', '频道文件夹'],
  },
  {
    id: 'usage',
    group: 'team',
    label: '用量与成本',
    icon: SettingsIcons.chart,
    planned: ['本月运行', '按智能体', '按频道', '按模型', '预算与提醒'],
  },
  {
    id: 'audit',
    group: 'team',
    label: '审计记录',
    icon: SettingsIcons.scroll,
    planned: ['人的操作', '智能体的操作', '运行记录'],
  },
  {
    id: 'data',
    group: 'team',
    label: '数据与导出',
    icon: SettingsIcons.download,
    planned: ['导出', '保留期限', '备份'],
  },
];
const GROUPS = [
  { id: 'personal', label: '个人' },
  { id: 'team', label: '团队' },
] as const;
/** Where each entry opens: your menu on 通知, the team's on 成员. */
export const FIRST = { personal: 'notifications', team: 'members' } as const;
export const sectionOf = (id: string) => SECTIONS.find((s) => s.id === id);

/**
 * In settings the sidebar is the map: back to where you were, then the
 * sections by group, the current one lit as a channel is.
 */
export function SettingsNav({
  current,
  onSelect,
  onBack,
}: {
  current: string;
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <nav className="settings-nav" aria-label="设置">
      <div className="settings-nav-head">
        <button
          type="button"
          className="quiet icon-button"
          aria-label="返回"
          title="返回"
          onClick={onBack}
        >
          <BackIcon size={20} />
        </button>
        <h2>设置</h2>
      </div>
      {GROUPS.map((group) => (
        <section key={group.id} aria-label={group.label}>
          <div className="nav-heading">
            <h2>{group.label}</h2>
          </div>
          {SECTIONS.filter((s) => s.group === group.id).map((s) => (
            <button
              key={s.id}
              type="button"
              className="settings-nav-item"
              data-planned={s.planned ? 'true' : undefined}
              aria-current={current === s.id ? 'page' : undefined}
              onClick={() => {
                onSelect(s.id);
              }}
            >
              <s.icon size={20} />
              <span>{s.label}</span>
            </button>
          ))}
        </section>
      ))}
    </nav>
  );
}
/** A phone's map: the two groups as iOS grouped lists. */
export function SettingsList({ onSelect }: { onSelect: (id: string) => void }) {
  return (
    <div className="settings-list">
      {GROUPS.map((group) => (
        <section key={group.id} aria-label={group.label}>
          <h2>{group.label}</h2>
          <ul>
            {SECTIONS.filter((s) => s.group === group.id).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  data-planned={s.planned ? 'true' : undefined}
                  onClick={() => {
                    onSelect(s.id);
                  }}
                >
                  <s.icon size={20} />
                  <span>{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
/** One row: a label, and its value or control at the end. */
function Row({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div className="you-row">
      <span>{label}</span>
      <span className="you-row-end">{children}</span>
    </div>
  );
}
/** A planned section: the rows it will hold, quiet, and that it is coming. */
function Planned({ rows }: { rows: string[] }) {
  return (
    <section className="settings-planned">
      <p className="muted">规划中</p>
      <div className="you-rows">
        {rows.map((row) => (
          <Row key={row} label={row}>
            —
          </Row>
        ))}
      </div>
    </section>
  );
}
function Appearance() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <div className="you-rows">
      <ChoiceRow
        label="外观"
        options={[
          { id: 'system', label: '跟随系统' },
          { id: 'light', label: '浅色' },
          { id: 'dark', label: '深色' },
        ]}
        value={theme}
        disabled={false}
        onChoose={(next) => {
          applyTheme(next);
          setTheme(next);
        }}
      />
    </div>
  );
}
const Profile = z.object({
  username: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  team: z.string(),
});
function ProfileSection({ data }: { data: WorkspaceSnapshot }) {
  const [profile, setProfile] = useState<z.infer<typeof Profile> | null>(null);
  useEffect(() => {
    void api('/api/me/profile').then(
      (raw) => {
        setProfile(Profile.parse(raw));
      },
      () => undefined,
    );
  }, []);
  return (
    <>
      <div className="settings-identity">
        <Avatar
          kind="human"
          name={data.human.name}
          id={data.human.id}
          size="xl"
        />
        <strong>{data.human.name}</strong>
      </div>
      <div className="you-rows">
        <Row label="账号">{profile?.username ?? data.human.username}</Row>
        <Row label="邮箱">{profile?.email ?? '—'}</Row>
        <Row label="团队">{profile?.team ?? data.team.name}</Row>
      </div>
    </>
  );
}
const Sessions = z.array(
  z.object({
    id: z.string(),
    current: z.boolean(),
    createdAt: z.string(),
    lastSeenAt: z.string(),
  }),
);
const Browsers = z.array(
  z.object({ id: z.string(), service: z.string(), createdAt: z.string() }),
);
/** The browser behind a push service, by the service's host. */
const browserName = (host: string) =>
  host.endsWith('push.apple.com')
    ? 'Safari'
    : host.includes('mozilla')
      ? 'Firefox'
      : host.includes('notify.windows.com')
        ? 'Edge'
        : 'Chrome';
function AccountSection({
  onSignOut,
  onSignOutEverywhere,
}: {
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
}) {
  const action = useRequest();
  const [sessions, setSessions] = useState<z.infer<typeof Sessions>>([]);
  const [browsers, setBrowsers] = useState<z.infer<typeof Browsers>>([]);
  const load = () => {
    void api('/api/me/sessions').then(
      (raw) => {
        setSessions(Sessions.parse(raw));
      },
      () => undefined,
    );
    void api('/api/push/browsers').then(
      (raw) => {
        setBrowsers(Browsers.parse(raw));
      },
      () => undefined,
    );
  };
  useEffect(load, []);
  const end = (path: string, id: string) =>
    void action.send(path, { id }).then((done) => {
      if (done !== undefined) load();
    });
  return (
    <>
      <section className="you-rows" aria-label="登录">
        {sessions.map((s) => (
          <Row
            key={s.id}
            label={s.current ? '此浏览器' : `${ago(s.createdAt)}登录`}
          >
            {s.current ? (
              <span className="muted">正在使用</span>
            ) : (
              <>
                <span className="muted">{ago(s.lastSeenAt)}用过</span>
                <button
                  type="button"
                  className="link-button"
                  disabled={action.disabled}
                  onClick={() => {
                    end('/api/me/session/end', s.id);
                  }}
                >
                  退出
                </button>
              </>
            )}
          </Row>
        ))}
      </section>
      {browsers.length > 0 && (
        <section className="you-rows" aria-label="接收通知的浏览器">
          {browsers.map((b) => (
            <Row key={b.id} label={`${browserName(b.service)} 接收通知`}>
              <button
                type="button"
                className="link-button"
                disabled={action.disabled}
                onClick={() => {
                  end('/api/push/forget', b.id);
                }}
              >
                移除
              </button>
            </Row>
          ))}
        </section>
      )}
      {action.error && <Notice>{action.error}</Notice>}
      <SignOuts
        onSignOut={onSignOut}
        onSignOutEverywhere={onSignOutEverywhere}
      />
    </>
  );
}
const SHORTCUTS = [
  ['搜索', '⌘ K'],
  ['发送消息', '⌘ ↵'],
  ['设置', '⌘ ,'],
  ['收起或展开侧栏', '⌘ \\'],
  ['返回', 'Esc'],
] as const;
function Shortcuts() {
  return (
    <div className="you-rows">
      {SHORTCUTS.map(([label, keys]) => (
        <Row key={label} label={label}>
          <kbd>{keys}</kbd>
        </Row>
      ))}
    </div>
  );
}
function Members({ data }: { data: WorkspaceSnapshot }) {
  return (
    <ul className="settings-people" aria-label="成员">
      {data.people.map((person) => (
        <li key={person.id}>
          <Avatar kind="human" name={person.name} id={person.id} size="md" />
          <span className="settings-people-name">{person.name}</span>
          <span className="muted">{person.username}</span>
          <Presence online={person.id === data.human.id || person.online} dot />
        </li>
      ))}
    </ul>
  );
}
function Channels({
  data,
  openChannel,
}: {
  data: WorkspaceSnapshot;
  openChannel: (id: string) => void;
}) {
  return (
    <ul className="settings-people" aria-label="频道">
      {data.channels.items.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => {
              openChannel(c.id);
            }}
          >
            <ChannelIcon id={c.id} name={c.name} />
            <span className="settings-people-name">{c.name}</span>
            <span className="muted">
              {data.muted.channels.includes(c.id) ? '已静音' : ''}
            </span>
          </button>
        </li>
      ))}
      {data.leftChannels.map((c) => (
        <li key={c.id} data-left="true">
          <ChannelIcon id={c.id} name={c.name} />
          <span className="settings-people-name">{c.name}</span>
          <span className="muted">已退出</span>
        </li>
      ))}
    </ul>
  );
}
function Agents({
  data,
  openAgent,
}: {
  data: WorkspaceSnapshot;
  openAgent: (id: string) => void;
}) {
  return (
    <ul className="settings-people" aria-label="智能体">
      {data.agents.map((agent) => {
        const managed = data.managed.some((m) => m.agentId === agent.id);
        const awake = workerConnected(data.wake, agent.id);
        return (
          <li key={agent.id}>
            <button
              type="button"
              onClick={() => {
                openAgent(agent.id);
              }}
            >
              <Avatar kind="agent" name={agent.name} id={agent.id} size="md" />
              <span className="settings-people-name">{agent.name}</span>
              <span className="muted">
                {[
                  agent.preferences.modelId,
                  managed ? '由 Kinmesh 运行' : awake ? '由你运行' : '未运行',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <Presence online={awake} dot />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
function Connections({ data }: { data: WorkspaceSnapshot }) {
  const t3 = useT3(data.team.id);
  const connection = t3.status?.connection ?? null;
  const where = connection && t3Where(connection);
  const action = useRequest({
    409: '你还没有用飞书登录过。',
    502: '飞书机器人发不出消息：检查应用的机器人能力和发消息权限。',
  });
  const [sent, setSent] = useState(false);
  return (
    <>
      <section className="you-rows" aria-label="T3">
        <Row label="T3">
          {where ? where.host : <span className="muted">未连接</span>}
        </Row>
        {connection && (
          <>
            <Row label="运行方式">
              {connection.access === 'read'
                ? '只读'
                : connection.ceiling
                  ? MODE_NAMES[connection.ceiling]
                  : '—'}
            </Row>
            <Row label="登录">
              {connection.expired ? (
                <span className="danger-text">已到期</span>
              ) : (
                '有效'
              )}
            </Row>
          </>
        )}
      </section>
      <section className="you-rows" aria-label="飞书">
        <Row label="飞书机器人">
          <button
            type="button"
            className="link-button"
            disabled={action.disabled}
            onClick={() => {
              void action.send('/api/feishu/test', {}).then((done) => {
                if (done !== undefined) setSent(true);
              });
            }}
          >
            {sent ? '已发送，去飞书看看' : '给我发一条测试消息'}
          </button>
        </Row>
      </section>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/** The section a settings address names, as its page shows it. */
export function SettingsSection({
  id,
  data,
  onSignOut,
  onSignOutEverywhere,
  openChannel,
  openAgent,
}: {
  id: string;
  data: WorkspaceSnapshot;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  openChannel: (id: string) => void;
  openAgent: (id: string) => void;
}) {
  const section = sectionOf(id);
  if (!section) return null;
  if (section.planned) return <Planned rows={section.planned} />;
  switch (section.id) {
    case 'notifications':
      return <NotificationSettings data={data} />;
    case 'appearance':
      return <Appearance />;
    case 'profile':
      return <ProfileSection data={data} />;
    case 'account':
      return (
        <AccountSection
          onSignOut={onSignOut}
          onSignOutEverywhere={onSignOutEverywhere}
        />
      );
    case 'shortcuts':
      return <Shortcuts />;
    case 'members':
      return <Members data={data} />;
    case 'channels':
      return <Channels data={data} openChannel={openChannel} />;
    case 'agents':
      return <Agents data={data} openAgent={openAgent} />;
    case 'connections':
      return <Connections data={data} />;
    default:
      return null;
  }
}
/**
 * Settings as a page: on a wide screen the section beside the map, with no
 * title (the map says where you are); on a phone the map's list, or a
 * section under a bar that leads back to it.
 */
export function SettingsPage({
  section,
  phone,
  data,
  onSection,
  onClose,
  ...rest
}: {
  section: string;
  phone: boolean;
  data: WorkspaceSnapshot;
  onSection: (id: string) => void;
  onClose: () => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  openChannel: (id: string) => void;
  openAgent: (id: string) => void;
}) {
  if (phone && section === '')
    return (
      <Page label="设置" onClose={onClose} bar={false}>
        <SettingsList onSelect={onSection} />
      </Page>
    );
  const id = sectionOf(section) ? section : FIRST.personal;
  return (
    <Page
      label={sectionOf(id)?.label ?? '设置'}
      onClose={
        phone
          ? () => {
              onSection('');
            }
          : onClose
      }
      bar={phone ? undefined : false}
      className="settings-page"
    >
      <div className="page-body settings-body">
        <SettingsSection id={id} data={data} {...rest} />
      </div>
    </Page>
  );
}
