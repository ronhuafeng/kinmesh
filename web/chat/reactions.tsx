import type { z } from 'zod';
import {
  REACTIONS,
  type MessageReactions,
} from '../../src/domain/communication.js';
import { request } from '../shared/api.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName } from '../shared/names.js';
import * as Menu from '@radix-ui/react-dropdown-menu';

export type Reacted = z.infer<typeof MessageReactions>;
export type Emoji = (typeof REACTIONS)[number];
/** Adds or takes back your reaction; the conversation shows it as it lands. */
export function react(
  path: string,
  emoji: Emoji,
  on: boolean,
  done: () => void,
) {
  void request(path + '/reactions', { emoji, on }).then(done, () => undefined);
}
/**
 * Under a message: each reaction with how many, yours pressed; pressing one
 * adds or takes back yours. Who reacted is said on hover.
 */
export function Reactions({
  list,
  path,
  data,
  permitted,
  onDone,
}: {
  list: Reacted[];
  /** The message's address, `…/messages/<id>`. */
  path: string;
  data: WorkspaceSnapshot;
  permitted: boolean;
  onDone: () => void;
}) {
  if (list.length === 0) return null;
  return (
    <ul className="reactions" aria-label="回应">
      {list.map((r) => {
        const mine = r.humanIds.includes(data.human.id);
        const who = r.humanIds
          .map((id) => memberName({ kind: 'human', id }, data))
          .join('、');
        return (
          <li key={r.emoji}>
            <button
              type="button"
              aria-pressed={mine}
              aria-label={`${r.emoji} ${String(r.humanIds.length)}：${who}`}
              title={who}
              disabled={!permitted}
              onClick={() => {
                react(path, r.emoji, !mine, onDone);
              }}
            >
              <span aria-hidden="true">{r.emoji}</span>
              <span aria-hidden="true">{r.humanIds.length}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
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
