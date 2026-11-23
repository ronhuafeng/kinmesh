import { useMemo } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

/**
 * Pictures by member ID: agents' set here, people's from Feishu. One map
 * while they are unchanged (the workspace keeps unchanged parts the same
 * objects), so a toast or a status change redraws no Avatar.
 */
export function useAvatarImages(data: WorkspaceSnapshot | null) {
  const teamId = data?.team.id;
  const avatars = data?.avatars;
  const pictured = data?.people;
  return useMemo(
    () =>
      new Map([
        ...(avatars ?? []).map((a): [string, string] => [
          a.agentId,
          `/api/teams/${teamId ?? ''}/agents/${a.agentId}/avatar?v=${encodeURIComponent(a.updatedAt)}`,
        ]),
        ...(pictured ?? []).flatMap((p): [string, string][] =>
          p.avatar === null
            ? []
            : [
                [
                  p.id,
                  `/api/teams/${teamId ?? ''}/people/${p.id}/avatar?v=${encodeURIComponent(p.avatar)}`,
                ],
              ],
        ),
      ]),
    [teamId, avatars, pictured],
  );
}
