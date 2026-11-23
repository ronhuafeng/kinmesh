import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName, type Someone } from '../shared/names.js';
import { Avatar } from '../shared/avatar.js';

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
