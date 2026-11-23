import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, useRequest } from './api.js';
import { Notice } from './forms.js';
import { Files } from './files.js';
import { BackIcon, SettingsIcons } from './icons.js';
import {
  ChoiceRow,
  Group,
  ListRow,
  NotificationSettings,
  Pill,
  Row,
  SignOuts,
} from './settings.js';
import { MODE_NAMES, t3Where, useT3 } from './setup.js';
import { applyTheme, readTheme, type Theme } from './theme.js';
import { LEVEL_LABELS, levelOf } from './levels.js';
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
/**
 * What is coming, as one place at the end of the map: every planned
 * section's rows, so the map lists only what works.
 */
const COMING: Section = {
  id: 'coming',
  group: 'team',
  label: '即将推出',
  icon: SettingsIcons.sparkles,
};
export const sectionOf = (id: string) =>
  id === COMING.id ? COMING : SECTIONS.find((s) => s.id === id);
/** A group's sections as the map lists them: only those that work. */
const inOrder = (group: Section['group']) =>
  SECTIONS.filter((s) => s.group === group && !s.planned);
/** Which entry is lit: a planned section's address lights 即将推出. */
const lit = (current: string) =>
  sectionOf(current)?.planned ? COMING.id : current;

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
          {inOrder(group.id).map((s) => (
            <button
              key={s.id}
              type="button"
              className="settings-nav-item"
              aria-current={lit(current) === s.id ? 'page' : undefined}
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
      <section aria-label={COMING.label}>
        <button
          type="button"
          className="settings-nav-item"
          data-planned="true"
          aria-current={lit(current) === COMING.id ? 'page' : undefined}
          onClick={() => {
            onSelect(COMING.id);
          }}
        >
          <COMING.icon size={20} />
          <span>{COMING.label}</span>
        </button>
      </section>
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
            {inOrder(group.id).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
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
      <section aria-label={COMING.label}>
        <ul>
          <li>
            <button
              type="button"
              data-planned="true"
              onClick={() => {
                onSelect(COMING.id);
              }}
            >
              <COMING.icon size={20} />
              <span>{COMING.label}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  );
}
/** A planned section: the rows it will hold, quiet, and that it is coming. */
function Planned() {
  return (
    <div className="settings-planned">
      {SECTIONS.flatMap((s) =>
        s.planned
          ? [
              <Group key={s.id} title={s.label}>
                {s.planned.map((row) => (
                  <Row key={row} label={row}>
                    <span className="skeleton" aria-hidden="true" />
                  </Row>
                ))}
              </Group>,
            ]
          : [],
      )}
    </div>
  );
}
function Appearance() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  return (
    <Group>
      <ChoiceRow
        label="配色"
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
    </Group>
  );
}
const Profile = z.object({
  username: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  team: z.string(),
});
/** A read that failed: said where it would have shown, with a retry. */
function Unread({ what, retry }: { what: string; retry: () => void }) {
  return (
    <Notice>
      读不到{what}。
      <button type="button" className="link-button" onClick={retry}>
        再试一次
      </button>
    </Notice>
  );
}
function ProfileSection({ data }: { data: WorkspaceSnapshot }) {
  const [profile, setProfile] = useState<z.infer<typeof Profile> | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    void api('/api/me/profile').then(
      (raw) => {
        setProfile(Profile.parse(raw));
      },
      () => {
        setFailed(true);
      },
    );
  };
  useEffect(load, []);
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
        <Pill on>来自飞书</Pill>
      </div>
      <Group title="账号">
        <Row label="用户名">{profile?.username ?? data.human.username}</Row>
        <Row label="邮箱">{profile?.email ?? '—'}</Row>
        <Row label="团队">{profile?.team ?? data.team.name}</Row>
      </Group>
      {failed && <Unread what="账号信息" retry={load} />}
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
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    const failing = () => {
      setFailed(true);
    };
    void api('/api/me/sessions').then((raw) => {
      setSessions(Sessions.parse(raw));
    }, failing);
    void api('/api/push/browsers').then((raw) => {
      setBrowsers(Browsers.parse(raw));
    }, failing);
  };
  useEffect(load, []);
  const end = (path: string, id: string) =>
    void action.send(path, { id }).then((done) => {
      if (done !== undefined) load();
    });
  return (
    <>
      {failed && <Unread what="登录的设备" retry={load} />}
      <Group title="登录的设备">
        {sessions.map((s) => (
          <Row
            key={s.id}
            label={
              s.current ? (
                <>
                  此浏览器 <Pill on>正在使用</Pill>
                </>
              ) : (
                `${ago(s.createdAt)}登录`
              )
            }
          >
            {s.current ? null : (
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
      </Group>
      {browsers.length > 0 && (
        <Group title="接收通知的浏览器">
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
        </Group>
      )}
      {action.error && <Notice>{action.error}</Notice>}
      <SignOuts
        onSignOut={onSignOut}
        onSignOutEverywhere={onSignOutEverywhere}
      />
    </>
  );
}
/** The keys, with the modifier this computer uses: ⌘ on a Mac, else Ctrl. */
const SHORTCUTS = (mod: string) =>
  [
    ['搜索', mod + ' K'],
    ['发送消息', mod + ' ↵'],
    ['设置', mod + ' ,'],
    ['收起或展开侧栏', mod + ' \\'],
    ['返回', 'Esc'],
  ] as const;
function Shortcuts() {
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
  return (
    <Group>
      {SHORTCUTS(mod).map(([label, keys]) => (
        <Row key={label} label={label}>
          <kbd>{keys}</kbd>
        </Row>
      ))}
    </Group>
  );
}
/**
 * The people of the team by name. A handle shows only where two share a
 * name, to tell them apart; you are marked 你, and the others show whether
 * they are here.
 */
function Members({ data }: { data: WorkspaceSnapshot }) {
  const named = new Map<string, number>();
  for (const p of data.people) named.set(p.name, (named.get(p.name) ?? 0) + 1);
  return (
    <ul className="list-rows" aria-label="成员">
      {data.people.map((person) => {
        const you = person.id === data.human.id;
        return (
          <ListRow
            key={person.id}
            lead={
              <Avatar
                kind="human"
                name={person.name}
                id={person.id}
                size="md"
              />
            }
            title={
              <>
                {person.name}
                {you && (
                  <>
                    {' '}
                    <Pill>你</Pill>
                  </>
                )}
              </>
            }
            detail={
              (named.get(person.name) ?? 0) > 1 ? person.username : undefined
            }
            end={you ? undefined : <Presence online={person.online} dot />}
          />
        );
      })}
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
  const joined = (
    <ul className="list-rows" aria-label="已加入的频道">
      {data.channels.items.map((c) => {
        const level = levelOf(data, c.id);
        return (
          <ListRow
            key={c.id}
            lead={<ChannelIcon id={c.id} name={c.name} />}
            title={
              <>
                {c.name}
                {level !== 'default' && (
                  <>
                    {' '}
                    <Pill>{LEVEL_LABELS[level]}</Pill>
                  </>
                )}
              </>
            }
            onOpen={() => {
              openChannel(c.id);
            }}
          />
        );
      })}
    </ul>
  );
  // Channels you left are a group of their own; with none, one list.
  if (data.leftChannels.length === 0) return joined;
  return (
    <>
      <Group title="已加入">{joined}</Group>
      <Group title="已退出">
        <ul className="list-rows" aria-label="已退出的频道">
          {data.leftChannels.map((c) => (
            <ListRow
              key={c.id}
              quiet
              lead={<ChannelIcon id={c.id} name={c.name} />}
              title={c.name}
            />
          ))}
        </ul>
      </Group>
    </>
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
    <ul className="list-rows" aria-label="智能体">
      {data.agents.map((agent) => {
        const managed = data.managed.some((m) => m.agentId === agent.id);
        const awake = workerConnected(data.wake, agent.id);
        return (
          <ListRow
            key={agent.id}
            lead={
              <Avatar kind="agent" name={agent.name} id={agent.id} size="md" />
            }
            title={agent.name}
            detail={[
              agent.preferences.modelId,
              managed ? '由 Kinmesh 运行' : awake ? '由你运行' : '未运行',
            ]
              .filter(Boolean)
              .join(' · ')}
            end={<Presence online={awake} dot />}
            onOpen={() => {
              openAgent(agent.id);
            }}
          />
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
      <Group title="T3">
        <Row label="地址">
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
            {t3.status?.pairing && <Pairing teamId={data.team.id} />}
          </>
        )}
      </Group>
      <Group title="飞书">
        <Row label="机器人">
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
      </Group>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
const Paired = z.object({
  token: z.string(),
  expiresAt: z.string(),
  url: z.string(),
});
/**
 * A pairing code for this browser (or another) to reach the team's T3:
 * T3 asks for one before it lets a browser in, to approve a sign-in or open
 * a run. The code shows with the link that pairs at once, and how long it
 * lasts; a new one replaces it.
 */
function Pairing({ teamId }: { teamId: string }) {
  const action = useRequest({ 409: '这个 T3 不能从这里配对。' });
  const [paired, setPaired] = useState<z.infer<typeof Paired> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The code says when it stops working, and goes once it has.
  useEffect(() => {
    if (paired === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [paired]);
  const live = paired !== null && Date.parse(paired.expiresAt) > now;
  return (
    <>
      <Row label="配对码">
        <button
          type="button"
          className="link-button"
          disabled={action.disabled}
          onClick={() => {
            void action.send(`/api/teams/${teamId}/t3/pair`, {}).then((raw) => {
              if (raw === undefined) return;
              setPaired(Paired.parse(raw));
              setNow(Date.now());
            });
          }}
        >
          {live ? '换一个' : '生成配对码'}
        </button>
      </Row>
      {live && (
        <div className="pairing">
          <code className="pairing-code">{paired.token}</code>
          <span className="muted">
            {new Date(paired.expiresAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            前有效
          </span>
          <a href={paired.url} target="_blank" rel="noreferrer">
            在 T3 中配对
          </a>
        </div>
      )}
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
  openMessage,
}: {
  id: string;
  data: WorkspaceSnapshot;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  openChannel: (id: string) => void;
  openAgent: (id: string) => void;
  openMessage: (channelId: string, messageId: string) => void;
}) {
  const section = sectionOf(id);
  if (!section) return null;
  if (section.planned || section.id === COMING.id) return <Planned />;
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
    case 'files':
      return <Files data={data} openMessage={openMessage} />;
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
  openMessage: (channelId: string, messageId: string) => void;
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
