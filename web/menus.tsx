import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { useState, type ReactNode } from 'react';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { request } from './api.js';
import { SettingsIcons } from './icons.js';
import { tomorrowMorning } from './settings.js';
import { applyTheme, readTheme, type Theme } from './theme.js';
import {
  ChannelLevel,
  nextOpening,
  withinHours,
} from '../src/domain/notify.js';
import { LEVEL_LABELS, levelOf, setLevel } from './levels.js';

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
  onFailed,
}: {
  data: WorkspaceSnapshot;
  onSettings: (section: string) => void;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  /** Says an action didn't happen, where the person will see it. */
  onFailed: (message: string) => void;
}) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const paused = until(data.pausedUntil);
  // Outside your hours, when they open again.
  const opens = withinHours(new Date(), data.hours)
    ? null
    : nextOpening(new Date(), data.hours);
  const pause = (at: Date | null) =>
    void request(
      '/api/me/pause',
      { until: at === null ? null : at.toISOString() },
      'PUT',
    ).catch(() => {
      onFailed('没能改好，请再试一次。');
    });
  return (
    <Menu.Root>
      <Menu.Trigger className="account-row" aria-label="你的账户">
        <Mark
          name={data.human.name}
          quiet={paused !== null || opens !== null}
        />
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
            {paused
              ? `通知暂停到 ${clockOf(paused)}`
              : opens
                ? `通知时段外，${clockOf(opens)} 恢复`
                : '通知已开'}
          </p>
          {paused ? (
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
          )}
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
/**
 * A channel's own menu, on its row in the sidebar (right-click, or a long
 * press on a phone): how loud it is for you, and leaving it.
 */
export function ChannelMenu({
  data,
  channelId,
  channelName,
  onLeave,
  onFailed,
  children,
}: {
  data: WorkspaceSnapshot;
  channelId: string;
  channelName: string;
  onLeave: (channelId: string) => void;
  /** Says an action didn't happen, where the person will see it. */
  onFailed: (message: string) => void;
  children: ReactNode;
}) {
  const level = levelOf(data, channelId);
  const visibility =
    data.channels.items.find((c) => c.id === channelId)?.visibility ??
    'private';
  // Opening a channel to the whole team takes a second press.
  const [opening, setOpening] = useState(false);
  return (
    <ContextMenu.Root
      onOpenChange={() => {
        setOpening(false);
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" collisionPadding={8}>
          <p className="menu-state">#{channelName}</p>
          <ContextMenu.RadioGroup
            value={level}
            onValueChange={(value) => {
              const next = ChannelLevel.safeParse(value);
              if (next.success)
                void setLevel(data.team.id, channelId, next.data).catch(() => {
                  onFailed('没能改好，请再试一次。');
                });
            }}
          >
            {/* Loudest first. */}
            {(['follow', 'default', 'mute'] as const).map((option) => (
              <ContextMenu.RadioItem
                key={option}
                value={option}
                className="menu-item"
              >
                <span className="menu-icon">
                  {option === 'follow' ? (
                    <SettingsIcons.bell size={16} />
                  ) : option === 'mute' ? (
                    <SettingsIcons.moon size={16} />
                  ) : null}
                </span>
                <span className="menu-label">{LEVEL_LABELS[option]}</span>
                <ContextMenu.ItemIndicator className="menu-check">
                  <SettingsIcons.check size={16} />
                </ContextMenu.ItemIndicator>
              </ContextMenu.RadioItem>
            ))}
          </ContextMenu.RadioGroup>
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item
            className="menu-item"
            onSelect={(event) => {
              if (visibility === 'private' && !opening) {
                event.preventDefault();
                setOpening(true);
                return;
              }
              void request(
                `/api/teams/${data.team.id}/channels/${channelId}/visibility`,
                {
                  operationKey: crypto.randomUUID(),
                  visibility: visibility === 'private' ? 'public' : 'private',
                },
              ).catch(() => {
                onFailed('没能改好，请再试一次。');
              });
            }}
          >
            <span className="menu-icon">
              {visibility === 'private' ? (
                <SettingsIcons.globe size={16} />
              ) : (
                <SettingsIcons.lock size={16} />
              )}
            </span>
            <span className="menu-label">
              {visibility === 'public'
                ? '设为私密'
                : opening
                  ? '确认：团队里所有人都能查看'
                  : '设为公开…'}
            </span>
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            data-danger="true"
            onSelect={() => {
              onLeave(channelId);
            }}
          >
            <span className="menu-icon">
              <SettingsIcons.logOut size={16} />
            </span>
            <span className="menu-label">退出 #{channelName}</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
/**
 * A member's row's menu (right-click, or a long press on a phone): taking
 * them out of the channel, in the danger colour. The hub decides who may.
 */
export function MemberMenu({
  channelPath,
  channelName,
  member,
  name,
  onFailed,
  onDone,
  children,
}: {
  channelPath: string;
  channelName: string;
  member: { kind: 'human' | 'agent'; id: string };
  name: string;
  onFailed: (message: string) => void;
  onDone: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" collisionPadding={8}>
          <p className="menu-state">{name}</p>
          <ContextMenu.Item
            className="menu-item"
            data-danger="true"
            onSelect={() => {
              void request(channelPath + '/participants/remove', {
                operationKey: crypto.randomUUID(),
                member,
              }).then(onDone, () => {
                onFailed(`没能把 ${name} 移出 #${channelName}，请再试一次。`);
              });
            }}
          >
            <span className="menu-icon">
              <SettingsIcons.logOut size={16} />
            </span>
            <span className="menu-label">
              把 {name} 移出 #{channelName}
            </span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
