import * as Menu from '@radix-ui/react-dropdown-menu';
import { useState, type ReactNode } from 'react';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { request } from './api.js';
import { SettingsIcons } from './icons.js';
import { tomorrowMorning } from './settings.js';
import { applyTheme, readTheme, type Theme } from './theme.js';

/**
 * A person's mark: their initials in a round of the primary colour, not
 * their picture. The last two characters of a Chinese name (as Feishu
 * shows one), the initials of a Latin one.
 */
export function initials(name: string) {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return '?';
  if (/\p{Script=Han}/u.test(name)) return chars.slice(-2).join('');
  const words = name.trim().split(/\s+/);
  return (
    words.length > 1
      ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')
      : chars.slice(0, 2).join('')
  ).toUpperCase();
}
export function Mark({
  name,
  quiet = false,
  size = 'md',
}: {
  name: string;
  /** Notifications paused: a small moon on its edge. */
  quiet?: boolean;
  size?: 'md' | 'lg';
}) {
  return (
    <span className="mark" data-size={size} aria-hidden="true">
      {initials(name)}
      {quiet && (
        <span className="mark-moon">
          <SettingsIcons.moon size={16} />
        </span>
      )}
    </span>
  );
}
const until = (iso: string | null) =>
  iso !== null && Date.parse(iso) > Date.now() ? new Date(iso) : null;
const clockOf = (at: Date) =>
  at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
/** One item of a menu: an icon, its words, and what it does. */
function Item({
  icon,
  children,
  shortcut,
  danger,
  onSelect,
}: {
  icon?: ReactNode;
  children: ReactNode;
  shortcut?: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <Menu.Item
      className="menu-item"
      data-danger={danger ? 'true' : undefined}
      onSelect={onSelect}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{children}</span>
      {shortcut && <kbd className="menu-shortcut">{shortcut}</kbd>}
    </Menu.Item>
  );
}
/**
 * Your mark at the foot of the sidebar opens what is about you: who you
 * are, whether you can be reached now (and a pause one choice away), how
 * Kinmesh looks, your settings, and signing out.
 */
export function AccountMenu({
  data,
  onSettings,
  onSignOut,
  onSignOutEverywhere,
}: {
  data: WorkspaceSnapshot;
  onSettings: (section: string) => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
}) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const paused = until(data.pausedUntil);
  const off = data.notify.length === 0;
  const pause = (at: Date | null) =>
    void request(
      '/api/me/pause',
      { until: at === null ? null : at.toISOString() },
      'PUT',
    ).catch(() => undefined);
  return (
    <Menu.Root>
      <Menu.Trigger className="account-row" aria-label="你的账户">
        <Mark name={data.human.name} quiet={paused !== null || off} />
        <span className="account-name">{data.human.name}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="menu"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <div className="menu-identity">
            <Mark name={data.human.name} size="lg" />
            <span>
              <strong>{data.human.name}</strong>
              <span className="muted">{data.team.name}</span>
            </span>
          </div>
          <p className="menu-state">
            {off
              ? '通知已关'
              : paused
                ? `通知暂停到 ${clockOf(paused)}`
                : '通知已开'}
          </p>
          {!off &&
            (paused ? (
              <Item
                icon={<SettingsIcons.bell size={16} />}
                onSelect={() => {
                  pause(null);
                }}
              >
                恢复通知
              </Item>
            ) : (
              <>
                <Item
                  icon={<SettingsIcons.moon size={16} />}
                  onSelect={() => {
                    pause(new Date(Date.now() + 60 * 60 * 1000));
                  }}
                >
                  暂停 1 小时
                </Item>
                <Item
                  icon={<span />}
                  onSelect={() => {
                    pause(tomorrowMorning(new Date()));
                  }}
                >
                  暂停到明早
                </Item>
              </>
            ))}
          <Menu.Separator className="menu-separator" />
          <Menu.RadioGroup
            value={theme}
            onValueChange={(value) => {
              const next: Theme =
                value === 'light' || value === 'dark' ? value : 'system';
              applyTheme(next);
              setTheme(next);
            }}
          >
            {(
              [
                ['system', '跟随系统'],
                ['light', '浅色'],
                ['dark', '深色'],
              ] as const
            ).map(([value, label], index) => (
              <Menu.RadioItem
                key={value}
                value={value}
                className="menu-item"
                onSelect={(event) => {
                  // Choosing how it looks keeps the menu open to see it.
                  event.preventDefault();
                }}
              >
                <span className="menu-icon">
                  {index === 0 && <SettingsIcons.appearance size={16} />}
                </span>
                <span className="menu-label">{label}</span>
                <Menu.ItemIndicator className="menu-check">
                  <SettingsIcons.check size={16} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <Menu.Separator className="menu-separator" />
          <Item
            icon={<SettingsIcons.person size={16} />}
            onSelect={() => {
              onSettings('profile');
            }}
          >
            个人资料
          </Item>
          <Item
            icon={<SettingsIcons.settings size={16} />}
            shortcut="⌘,"
            onSelect={() => {
              onSettings('notifications');
            }}
          >
            设置
          </Item>
          <Menu.Separator className="menu-separator" />
          <Item
            icon={<SettingsIcons.logOut size={16} />}
            danger
            onSelect={onSignOut}
          >
            退出登录
          </Item>
          <Item icon={<span />} danger onSelect={onSignOutEverywhere}>
            在所有设备上退出登录
          </Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
/**
 * The team's name opens what is about the team: its settings, and the
 * sections people reach for most. Later, switching teams.
 */
export function TeamMenu({
  data,
  children,
  onSettings,
}: {
  data: WorkspaceSnapshot;
  children: ReactNode;
  onSettings: (section: string) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="team-trigger" aria-label={data.team.name}>
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="menu"
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
        >
          <p className="menu-state">{data.team.name}</p>
          <Item
            icon={<SettingsIcons.users size={16} />}
            onSelect={() => {
              onSettings('members');
            }}
          >
            成员
          </Item>
          <Item
            icon={<SettingsIcons.bot size={16} />}
            onSelect={() => {
              onSettings('agents');
            }}
          >
            智能体
          </Item>
          <Item
            icon={<SettingsIcons.plug size={16} />}
            onSelect={() => {
              onSettings('connections');
            }}
          >
            连接
          </Item>
          <Menu.Separator className="menu-separator" />
          <Item
            icon={<SettingsIcons.settings size={16} />}
            onSelect={() => {
              onSettings('members');
            }}
          >
            团队设置
          </Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
