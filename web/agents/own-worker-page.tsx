import { useCallback, useEffect, useState } from 'react';
import { ProfileInput, type Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { useLive } from '../shared/live.js';
import { api, value } from '../shared/api.js';
import { ActionForm, Field, Notice } from '../shared/forms.js';
import { CopyButton } from '../shared/copy-button.js';
import {
  useSetupRequest,
  type ListedGrant,
  Grants,
  usable,
  managedOf,
} from '../shared/t3.js';
import {
  Issued,
  WORKER_SCOPES,
  LIFETIME_DAYS,
  Row,
  TokenOnce,
} from './setup-parts.js';
import { Page } from '../shared/page.js';

/**
 * Running a worker by hand: the operator owns its configuration file and
 * credential. Kept for deployments where the hub doesn't run the worker.
 */
export function OwnWorker({
  agent,
  data,
  managedGrantId,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  managedGrantId: string | null;
  onDone: () => void;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const base = `/api/teams/${data.team.id}/agents/${agent.id}`;
  const [grants, setGrants] = useState<ListedGrant[] | null>(null);
  // When the credentials were read: whether one is live is as of then.
  const [readAt, setReadAt] = useState(0);
  const [token, setToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false);
  const { begin, settle, drop, reads } = useLive();
  const load = useCallback(() => {
    begin('grants');
    void api(base + '/grants')
      .then((raw) => {
        const next = Grants.parse(raw);
        setGrants(next.grants);
        setReadAt(Date.now());
        setLoadError('');
        settle('grants', next.revision);
      })
      .catch(() => {
        setLoadError('现在无法加载凭据。');
        drop('grants');
      });
  }, [base, begin, settle, drop]);
  useEffect(load, [load, reads.grants]);
  // Another agent's credentials are another resource.
  useEffect(
    () => () => {
      drop('grants');
    },
    [base, drop],
  );
  const mutate = (path: string, body?: unknown) => {
    void send(path, body).then((raw) => {
      if (raw === undefined) return;
      if (raw !== null) setToken(Issued.parse(raw).token);
      load();
      onDone();
    });
  };
  const issueInput = {
    label: 'Inbox worker',
    scopes: WORKER_SCOPES,
    lifetimeSeconds: LIFETIME_DAYS * 86400,
  };
  const prefs = agent.preferences;
  const configured =
    prefs.environmentId !== null &&
    prefs.providerId !== null &&
    prefs.modelId !== null;
  const credential = grants?.find(
    (g) => g.id !== managedGrantId && usable(g, WORKER_SCOPES),
  );
  const binding = JSON.stringify(
    {
      agentId: agent.id,
      tokenFile: '/private/kinmesh/' + agent.name.toLowerCase() + '.json',
      t3Endpoint: 'https://<your-t3-host>/mcp',
      t3AuthFile: '/private/kinmesh/t3-oauth.json',
      isolatedProviderId: prefs.providerId ?? '<isolated-provider-id>',
      externalTeamMcpConfigured: true,
    },
    null,
    2,
  );
  return (
    <ol className="setup-steps">
      <Row step={configured ? 'done' : 'todo'} title="运行偏好">
        {configured && !editing ? (
          <p className="muted">
            {prefs.environmentId} · {prefs.providerId}/{prefs.modelId}{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setEditing(true);
              }}
            >
              编辑
            </button>
          </p>
        ) : (
          <ActionForm
            title="运行偏好"
            method="PUT"
            keyed={false}
            path={base}
            submit="保存偏好"
            onDone={() => {
              setEditing(false);
              onDone();
            }}
            build={(f) => {
              const read = (key: string) => value(f, key).trim() || null;
              return ProfileInput.parse({
                name: agent.name,
                role: agent.role,
                capabilities: agent.capabilities,
                memoryLocation: agent.memoryLocation,
                preferences: {
                  environmentId: read('environmentId'),
                  providerId: read('providerId'),
                  modelId: read('modelId'),
                },
              });
            }}
          >
            <Field label="T3 环境 ID">
              <input
                name="environmentId"
                required
                defaultValue={prefs.environmentId ?? ''}
              />
            </Field>
            <div className="field-row">
              <Field label="隔离的提供方 ID">
                <input
                  name="providerId"
                  required
                  defaultValue={prefs.providerId ?? ''}
                />
              </Field>
              <Field label="模型 ID">
                <input
                  name="modelId"
                  required
                  defaultValue={prefs.modelId ?? ''}
                />
              </Field>
            </div>
          </ActionForm>
        )}
      </Row>
      <Row step={credential ? 'done' : 'todo'} title="工作进程凭据">
        {token && (
          <TokenOnce
            token={token}
            agent={agent}
            where={
              <>
                把它保存为工作进程的 <code>tokenFile</code>（权限 0600）。
              </>
            }
            onDismiss={() => {
              setToken(null);
            }}
          />
        )}
        {!credential && !token && (
          <>
            <button
              type="button"
              disabled={!permitted || busy || agent.lifecycle !== 'active'}
              onClick={() => {
                mutate(base + '/grants', issueInput);
              }}
            >
              签发工作进程凭据
            </button>
          </>
        )}
        {grants && grants.length > 0 && (
          <ul className="grant-list" aria-label="凭据">
            {grants.map((g) => {
              const live =
                g.revokedAt === null && Date.parse(g.expiresAt) > readAt;
              const hubs = g.id === managedGrantId;
              return (
                <li key={g.id} data-live={live ? 'true' : undefined}>
                  <span>
                    {/* The label is stored with the credential, in English. */}
                    {g.label === 'Inbox worker' ? '工作进程' : g.label} ·{' '}
                    {g.revokedAt
                      ? '已吊销'
                      : live
                        ? new Date(g.expiresAt).toLocaleDateString('zh-CN') +
                          ' 到期'
                        : '已过期'}
                  </span>
                  {live && (
                    <span>
                      {/* The hub rotates its own credential by reconnecting. */}
                      {!hubs && (
                        <button
                          type="button"
                          className="quiet"
                          disabled={!permitted || busy}
                          onClick={() => {
                            mutate(`${base}/grants/${g.id}/rotate`, issueInput);
                          }}
                        >
                          轮换
                        </button>
                      )}
                      <button
                        type="button"
                        className="quiet subtle-danger"
                        disabled={!permitted || busy}
                        onClick={() => {
                          mutate(`${base}/grants/${g.id}/revoke`);
                        }}
                      >
                        吊销
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {(error || loadError) && <Notice>{error || loadError}</Notice>}
      </Row>
      <Row step="manual" title="T3 访问（在工作进程所在的机器上）">
        <p className="muted">
          在那台机器的浏览器中批准工作进程的 T3 OAuth 访问：
          <code>npm run t3:auth</code>。
        </p>
      </Row>
      <Row step="manual" title="收件箱工作进程绑定">
        <p className="muted">
          把这段加到工作进程私有的 <code>inbox.json</code>{' '}
          绑定中，替换占位内容，然后启动工作进程。
        </p>
        <pre className="binding-snippet">
          <code>{binding}</code>
        </pre>
        <CopyButton text={binding} label="复制绑定" />
      </Row>
    </ol>
  );
}
/** Running the worker by hand is a task of its own, on a page of its own. */
export function OwnWorkerPage({
  agent,
  data,
  onClose,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  onClose: () => void;
  onDone: () => void;
}) {
  const managed = managedOf(data, agent.id);
  return (
    <Page label="自己运行工作进程" onClose={onClose}>
      <div className="page-body">
        <h2>自己运行 {agent.name} 的工作进程</h2>
        <OwnWorker
          agent={agent}
          data={data}
          managedGrantId={managed?.grantId ?? null}
          onDone={onDone}
        />
      </div>
    </Page>
  );
}
