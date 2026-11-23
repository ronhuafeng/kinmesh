import * as Menu from '@radix-ui/react-dropdown-menu';
import { type ReactNode } from 'react';

/** One item of a menu: an icon, its words, and what it does. */
export function Item({
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
