import * as ContextMenu from '@radix-ui/react-context-menu';
import { type ReactNode } from 'react';
import { request } from '../shared/api.js';
import { SettingsIcons } from '../shared/icons.js';

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
