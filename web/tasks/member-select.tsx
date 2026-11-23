import type { Member } from '../../src/domain/communication.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { MemberOptions } from './member-options.js';

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
