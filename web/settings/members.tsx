import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ListRow } from '../shared/list-row.js';
import { Pill } from '../shared/pill.js';
import { Avatar } from '../shared/avatar.js';
import { Presence } from '../shared/presence.js';

/**
 * The people of the team by name. A handle shows only where two share a
 * name, to tell them apart; you are marked 你, and the others show whether
 * they are here.
 */
export function Members({ data }: { data: WorkspaceSnapshot }) {
  const named = new Map<string, number>();
  for (const p of data.people) named.set(p.name, (named.get(p.name) ?? 0) + 1);
  return (
    <ul className="list-rows" aria-label="成员">
      {data.people.map((person) => {
        const you = person.id === data.human.id;
        return (
          <ListRow
            key={person.id}
            lead={
              <Avatar
                kind="human"
                name={person.name}
                id={person.id}
                size="md"
              />
            }
            title={
              <>
                {person.name}
                {you && (
                  <>
                    {' '}
                    <Pill>你</Pill>
                  </>
                )}
              </>
            }
            detail={
              (named.get(person.name) ?? 0) > 1 ? person.username : undefined
            }
            end={you ? undefined : <Presence online={person.online} dot />}
          />
        );
      })}
    </ul>
  );
}
