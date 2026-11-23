import type { Member } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName } from '../shared/names.js';
import { Avatar } from '../shared/avatar.js';

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
