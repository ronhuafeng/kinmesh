import { z } from 'zod';
import { SettingsIcons } from '../shared/icons.js';

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
export const GROUPS = [
  { id: 'personal', label: '个人' },
  { id: 'team', label: '团队' },
] as const;
/** Where each entry opens: your menu on 通知, the team's on 成员. */
export const FIRST = { personal: 'notifications', team: 'members' } as const;
/**
 * What is coming, as one place at the end of the map: every planned
 * section's rows, so the map lists only what works.
 */
export const COMING: Section = {
  id: 'coming',
  group: 'team',
  label: '即将推出',
  icon: SettingsIcons.sparkles,
};
export const sectionOf = (id: string) =>
  id === COMING.id ? COMING : SECTIONS.find((s) => s.id === id);
/** A group's sections as the map lists them: only those that work. */
export const inOrder = (group: Section['group']) =>
  SECTIONS.filter((s) => s.group === group && !s.planned);
/** Which entry is lit: a planned section's address lights 即将推出. */
export const lit = (current: string) =>
  sectionOf(current)?.planned ? COMING.id : current;
export const Profile = z.object({
  username: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  team: z.string(),
});
export const Sessions = z.array(
  z.object({
    id: z.string(),
    current: z.boolean(),
    createdAt: z.string(),
    lastSeenAt: z.string(),
  }),
);
export const Browsers = z.array(
  z.object({ id: z.string(), service: z.string(), createdAt: z.string() }),
);
/** The browser behind a push service, by the service's host. */
export const browserName = (host: string) =>
  host.endsWith('push.apple.com')
    ? 'Safari'
    : host.includes('mozilla')
      ? 'Firefox'
      : host.includes('notify.windows.com')
        ? 'Edge'
        : 'Chrome';
/** The keys, with the modifier this computer uses: ⌘ on a Mac, else Ctrl. */
export const SHORTCUTS = (mod: string) =>
  [
    ['搜索', mod + ' K'],
    ['发送消息', mod + ' ↵'],
    ['设置', mod + ' ,'],
    ['收起或展开侧栏', mod + ' \\'],
    ['返回', 'Esc'],
  ] as const;
export const Paired = z.object({
  token: z.string(),
  expiresAt: z.string(),
  url: z.string(),
});
