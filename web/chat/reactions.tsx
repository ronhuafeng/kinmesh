import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName } from '../shared/names.js';
import { type Reacted, react } from './react.js';

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
