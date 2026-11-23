import { useState } from 'react';
import type { Member } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { PlusIcon } from '../shared/icons.js';
import { memberFrom } from './model.js';
import { MemberAvatar } from './member-avatar.js';
import { MemberOptions } from './member-options.js';

/** Choosing a person: their face, or an empty one, and their name. */
export function PersonPicker({
  name,
  label,
  data,
  initial,
  people = false,
  exclude = null,
}: {
  name: string;
  label: string;
  data: WorkspaceSnapshot;
  initial: string;
  /** Only people, and always someone: who decides on a task. */
  people?: boolean;
  /** Someone who can't be chosen here, such as the owner as reviewer. */
  exclude?: Member | null;
}) {
  const [chosen, setChosen] = useState(initial);
  const member = chosen ? memberFrom(chosen) : null;
  return (
    <span className="person-picker">
      {member ? (
        <MemberAvatar member={member} data={data} />
      ) : (
        <span className="avatar-empty" aria-hidden="true">
          <PlusIcon />
        </span>
      )}
      <select
        name={name}
        aria-label={label}
        value={chosen}
        onChange={(e) => {
          setChosen(e.target.value);
        }}
      >
        {!people && <option value="">选择…</option>}
        <MemberOptions data={data} people={people} exclude={exclude} />
      </select>
    </span>
  );
}
