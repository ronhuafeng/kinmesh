import { useState } from 'react';
import { z } from 'zod';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Notice } from './notice.js';
import { useSetupRequest } from './use-setup-request.js';
import { Approve } from './approve.js';

/**
 * Sign in to the team's T3 again, wherever that is asked for: the same
 * sign-in as connecting it, to the T3 already connected.
 */
export function ReconnectT3({
  teamId,
  renewal,
  onDone,
}: {
  teamId: string;
  renewal: NonNullable<WorkspaceSnapshot['attention']['t3']>;
  onDone: () => void;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [approval, setApproval] = useState<string | null>(null);
  const approvalUrl = approval ?? renewal.authorizationUrl;
  if (renewal.signIn === 'waiting' && approvalUrl !== null)
    return (
      <Approve
        teamId={teamId}
        url={approvalUrl}
        pasteCallback={renewal.pasteCallback}
        agentName="智能体"
        reload={onDone}
      />
    );
  return (
    <div className="delivery-recovery">
      <button
        type="button"
        disabled={!permitted || busy}
        onClick={() => {
          void send(`/api/teams/${teamId}/t3/connect`, {
            endpoint: renewal.endpoint,
            replace: true,
          }).then((raw) => {
            if (raw === undefined) return;
            setApproval(
              z.object({ authorizationUrl: z.string().nullable() }).parse(raw)
                .authorizationUrl,
            );
            onDone();
          });
        }}
      >
        {busy ? '正在开始…' : '重新连接 T3'}
      </button>
      {renewal.signIn === 'failed' && (
        <Notice>T3 没有批准连接。再试一次。</Notice>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
