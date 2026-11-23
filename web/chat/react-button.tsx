import * as Menu from '@radix-ui/react-dropdown-menu';
import { REACTIONS } from '../../src/domain/communication.js';
import { type Emoji, react } from './react.js';

/** In a message's actions: the reactions to choose from. */
export function ReactButton({
  path,
  mine,
  permitted,
  onDone,
}: {
  path: string;
  /** The reactions already yours, ticked. */
  mine: Emoji[];
  permitted: boolean;
  onDone: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="quiet" disabled={!permitted}>
        回应
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="menu reaction-menu"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label="回应"
        >
          {REACTIONS.map((emoji) => (
            <Menu.CheckboxItem
              key={emoji}
              className="menu-item"
              checked={mine.includes(emoji)}
              onSelect={() => {
                react(path, emoji, !mine.includes(emoji), onDone);
              }}
            >
              {emoji}
            </Menu.CheckboxItem>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
