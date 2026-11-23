import { useRequest, value } from './api.js';
import { Field, Notice } from './forms.js';
import { useState } from 'react';
import { z } from 'zod';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { useSetupRequest } from './t3.js';

/**
 * A sign-in under way: the approval opens in T3. When T3's approval ends on
 * the person's own computer, its address is pasted here to finish.
 */
export function Approve({
  teamId,
  url,
  pasteCallback,
  agentName,
  reload,
}: {
  teamId: string;
  url: string;
  pasteCallback: boolean;
  agentName: string;
  reload: () => void;
}) {
  const pasted = useRequest({
    400: '这不是这次批准打开的地址。',
    409: '这已不适用，面板显示了变化。',
  });
  return (
    <div className="approve">
      <a
        className="button-link"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        在 T3 中批准 ↗
      </a>
      <span className="muted" role="status">
        等待你批准…
      </span>
      <ul className="approve-hints">
        <li>
          选择 {agentName} 的运行方式：<strong>监督</strong>、
          <strong>自动</strong>或<strong>完全访问</strong>。
        </li>
        <li>
          需要配对码？在 {new URL(url).host} 的 Settings → Sharing &amp; access
          中创建。
        </li>
      </ul>
      {pasteCallback && (
        <form
          className="t3-connect"
          onSubmit={(event) => {
            event.preventDefault();
            const address = value(new FormData(event.currentTarget), 'url');
            void pasted
              .send(`/api/teams/${teamId}/t3/callback`, { url: address })
              .then((raw) => {
                if (raw !== undefined) reload();
              });
          }}
        >
          <Field label="批准后的地址">
            <input
              name="url"
              type="url"
              required
              autoComplete="off"
              placeholder="http://127.0.0.1:49871/callback?…"
            />
          </Field>
          <div className="token-actions">
            <button type="submit" disabled={!pasted.permitted || pasted.busy}>
              {pasted.busy ? '正在完成…' : '完成'}
            </button>
          </div>
        </form>
      )}
      {pasted.error && <Notice>{pasted.error}</Notice>}
    </div>
  );
}
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
