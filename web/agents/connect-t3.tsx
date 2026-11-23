import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api, value } from '../shared/api.js';
import { Field } from '../shared/forms.js';
import { Notice } from '../shared/forms.js';
import type { T3Status } from '../shared/t3.js';
import { useSetupRequest } from '../shared/t3.js';
import { NextStep } from './setup-parts.js';
import { Approve } from '../shared/reconnect-t3.js';

/**
 * Connect the team to T3 once. The T3 desktop app on this machine is found
 * on its own; another T3 takes its MCP URL.
 */
export function ConnectT3({
  teamId,
  t3,
  reload,
  agentName,
}: {
  teamId: string;
  t3: T3Status | null;
  reload: () => void;
  agentName: string;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [approval, setApproval] = useState<string | null>(null);
  const [local, setLocal] = useState<string | null | undefined>(undefined);
  const [other, setOther] = useState(false);
  useEffect(() => {
    void api(`/api/teams/${teamId}/t3/local`)
      .then((raw) => {
        setLocal(
          z.object({ endpoint: z.string().nullable() }).parse(raw).endpoint,
        );
      })
      .catch(() => {
        setLocal(null);
      });
  }, [teamId]);
  const connection = t3?.connection ?? null;
  const readOnly = connection?.access === 'read';
  const ended = connection?.expired === true;
  // The approval page this page started, else the one the hub keeps for you
  // (after a reload, or from another tab).
  const approvalUrl = approval ?? t3?.authorizationUrl ?? null;
  const waiting = t3?.signIn === 'waiting' && approvalUrl !== null;
  const start = (endpoint: string) => {
    void send(`/api/teams/${teamId}/t3/connect`, {
      endpoint,
      replace: connection !== null,
    }).then((raw) => {
      if (raw === undefined) return;
      setApproval(
        z.object({ authorizationUrl: z.string().nullable() }).parse(raw)
          .authorizationUrl,
      );
      reload();
    });
  };
  const askForUrl = other || local === null;
  return (
    <NextStep title={readOnly ? '允许 T3 运行' : '连接 T3'}>
      <p className="muted">
        {readOnly
          ? `T3 只允许读取，所以 ${agentName} 无法在那里运行。重新连接并选择运行方式。`
          : ended
            ? `T3 的登录已到期，${agentName} 在等待。重新连接即可继续。`
            : local && !other
              ? `T3 正在这台 Mac 上运行。连接一次，整个团队都能用。`
              : `粘贴 T3 的 MCP URL：Settings → Environments → Copy MCP URL。`}
      </p>
      {waiting ? (
        <Approve
          teamId={teamId}
          url={approvalUrl}
          pasteCallback={t3.pasteCallback}
          agentName={agentName}
          reload={reload}
        />
      ) : (
        <form
          className="t3-connect"
          onSubmit={(event) => {
            event.preventDefault();
            const typed = value(new FormData(event.currentTarget), 'endpoint');
            const endpoint = askForUrl ? typed.trim() : local;
            if (endpoint) start(endpoint);
          }}
        >
          {askForUrl && local !== undefined && (
            <Field label="T3 的 MCP URL">
              <input
                name="endpoint"
                type="url"
                required
                placeholder="https://t3.example/mcp"
                defaultValue={connection?.endpoint ?? ''}
              />
            </Field>
          )}
          <div className="token-actions">
            <button
              type="submit"
              disabled={!permitted || busy || local === undefined}
            >
              {busy ? '正在开始…' : '连接 T3'}
            </button>
            {local && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setOther((v) => !v);
                }}
              >
                {other ? '使用这台 Mac 上的 T3' : '使用其他 T3'}
              </button>
            )}
          </div>
        </form>
      )}
      {t3?.signIn === 'failed' && <Notice>T3 没有批准连接。再试一次。</Notice>}
      {error && <Notice>{error}</Notice>}
    </NextStep>
  );
}
