import * as Menu from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { request } from '../shared/api.js';
import { SettingsIcons } from '../shared/icons.js';
import { tomorrowMorning } from '../shared/format-time.js';
import { applyTheme, readTheme, type Theme } from '../shared/theme.js';
import { nextOpening, withinHours } from '../../src/domain/notify.js';
import { until, clockOf } from './menu-time.js';
import { Mark } from './mark.js';
import { Item } from './menu-item.js';

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
