import { type Member, memberKey } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import {
  joinedAgents,
  otherPeople,
  memberName,
  type Someone,
} from '../shared/names.js';
import { Avatar } from '../shared/faces.js';
import { useState } from 'react';
import { PlusIcon } from '../shared/icons.js';
import { memberFrom } from './model.js';

/** The people a task can go to: you and the channel's agents, as "kind:id". */
export function MemberOptions({
  data,
  exclude = null,
  people = false,
}: {
  data: WorkspaceSnapshot;
  exclude?: Member | null;
  /** People only: who may decide on a task. */
  people?: boolean;
}) {
  const shown = (member: Member) =>
    exclude === null || memberKey(member) !== memberKey(exclude);
  return (
    <>
      {shown({ kind: 'human', id: data.human.id }) && (
        <option value={'human:' + data.human.id}>{data.human.name}</option>
      )}
      {otherPeople(data)
        .filter((person) => shown({ kind: 'human', id: person.id }))
        .map((person) => (
          <option value={'human:' + person.id} key={person.id}>
            {person.name}
          </option>
        ))}
      {joinedAgents(data)
        .filter((a) => !people && shown({ kind: 'agent', id: a.id }))
        .map((a) => (
          <option value={'agent:' + a.id} key={a.id}>
            {a.name}
          </option>
        ))}
    </>
  );
}
export function MemberSelect({
  id,
  name,
  data,
  required = false,
  empty = '未分配',
  exclude = null,
}: {
  /** Supplied by the wrapping Field, so its label names this select. */
  id?: string;
  name: string;
  data: WorkspaceSnapshot;
  required?: boolean;
  empty?: string;
  exclude?: Member | null;
}) {
  return (
    <select id={id} name={name} required={required} defaultValue="">
      <option value="">{empty}</option>
      <MemberOptions data={data} exclude={exclude} />
    </select>
  );
}
export function MemberAvatar({
  member,
  data,
}: {
  member: Someone | null;
  data: WorkspaceSnapshot;
}) {
  if (!member) return null;
  return (
    <Avatar
      kind={member.kind}
      name={memberName(member, data)}
      id={member.id}
      size="sm"
    />
  );
}
export function MemberChip({
  member,
  data,
}: {
  member: Member | null;
  data: WorkspaceSnapshot;
}) {
  const name = memberName(member, data);
  return (
    <span className="member-chip" data-kind={member?.kind ?? 'none'}>
      {member && (
        <Avatar kind={member.kind} name={name} id={member.id} size="sm" />
      )}
      {name}
    </span>
  );
}
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
