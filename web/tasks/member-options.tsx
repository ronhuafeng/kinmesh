import type { Member } from '../../src/domain/communication.js';
import { memberKey } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { joinedAgents, otherPeople } from '../shared/names.js';

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
