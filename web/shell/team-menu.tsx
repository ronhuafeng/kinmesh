import * as Menu from '@radix-ui/react-dropdown-menu';
import { type ReactNode } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { SettingsIcons } from '../shared/icons.js';
import { Item } from './menu-item.js';

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
