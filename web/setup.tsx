import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { Grant, ProfileInput } from '../src/domain/agents.js';
import type { Agent, Scope } from '../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { useLive } from './live.js';
import { api, useRequest, value } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';
import { ago, Avatar, Page, workerConnected } from './ui.js';

/** Scopes the Inbox worker needs (docs/collaboration.md, Grants and scopes). */
const WORKER_SCOPES: Scope[] = [
  'channels:read',
  'channels:write',
  'tasks:read',
  'tasks:write',
  'tasks:review',
  'executions:read',
  'executions:write',
];
/** What the agent's provider uses to work with the team through Team MCP. */
const TEAM_MCP_SCOPES: Scope[] = [
  'channels:read',
  'channels:write',
  'tasks:read',
  'tasks:write',
  'tasks:review',
];
const LIFETIME_DAYS = 30;
const TEAM_MCP_URL = 'http://127.0.0.1:3001/mcp';
const ListedGrant = Grant.omit({ agentId: true, teamId: true });
type ListedGrant = z.infer<typeof ListedGrant>;
const Grants = z.object({ grants: z.array(ListedGrant), revision: z.string() });
const Issued = z.object({ grant: ListedGrant.loose(), token: z.string() });
const T3Status = z.object({
  connection: z
    .object({
      endpoint: z.string(),
      environmentId: z.string(),
      connectedAt: z.string(),
      access: z.enum(['operate', 'read']).nullable(),
      /** The mode the person chose in T3; null when unknown. */
      ceiling: z
        .enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])
        .nullable(),
      /** T3 no longer honours the sign-in. */
      expired: z.boolean(),
    })
    .nullable(),
  signIn: z.enum(['waiting', 'failed']).nullable(),
  /** Approval returns to the person's own computer, whose address they paste. */
  pasteCallback: z.boolean(),
  /** The deployment connects T3; a person may still sign in to it. */
  provisioned: z.boolean(),
  revision: z.string(),
});
type T3Status = z.infer<typeof T3Status>;
const Providers = z.object({
  providers: z.array(z.object({ id: z.string(), models: z.array(z.string()) })),
});
type Step = 'done' | 'todo' | 'manual';
type T3Connection = NonNullable<T3Status['connection']>;
/** T3's names for the modes a person chooses on its approval page. */
export const MODE_NAMES = {
  'approval-required': '监督',
  'auto-accept-edits': '自动接受编辑',
  auto: '自动',
  'full-access': '完全访问',
} as const;
/** Where the team's T3 is, and how agents run there, when that is known. */
export function t3Where(connection: T3Connection) {
  return {
    host: new URL(connection.endpoint).host,
    access:
      connection.access === 'read'
        ? '只读'
        : connection.ceiling === null
          ? null
          : MODE_NAMES[connection.ceiling],
  };
}
/** The worker Kinmesh runs for this agent, if it runs one. */
function managedOf(data: WorkspaceSnapshot, agentId: string) {
  return data.managed.find((m) => m.agentId === agentId) ?? null;
}
/** A setup request; a conflict means the page is behind what changed. */
const useSetupRequest = () =>
  useRequest({ 409: '这已不适用，面板显示了变化。' });

function usable(grant: ListedGrant, scopes: Scope[]) {
  return (
    grant.revokedAt === null &&
    Date.parse(grant.expiresAt) > Date.now() &&
    scopes.every((s) => grant.scopes.includes(s))
  );
}
function Row({
  step,
  title,
  children,
}: {
  step: Step;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="setup-step" data-step={step}>
      <span className="setup-mark" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span className="visually-hidden">
          {step === 'done'
            ? '（已完成）'
            : step === 'manual'
              ? '（在 Kinmesh 之外）'
              : '（待完成）'}
        </span>
        {children}
      </div>
    </li>
  );
}
/** Copy with visible feedback; clipboard access can be refused. */
function CopyButton({
  text,
  label,
  className = 'secondary',
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [done, setDone] = useState<'' | '已复制' | '复制失败'>('');
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setDone('已复制');
          },
          () => {
            setDone('复制失败');
          },
        );
      }}
    >
      {done || label}
    </button>
  );
}
/** Shown once: the token lives only in this component until dismissed. */
function TokenOnce({
  token,
  agent,
  where,
  onDismiss,
}: {
  token: string;
  agent: Agent;
  where: ReactNode;
  onDismiss: () => void;
}) {
  const file = JSON.stringify({ token }) + '\n';
  return (
    <div className="token-once" role="status">
      <p>
        <strong>现在就复制这个凭据。</strong>Kinmesh
        只保存它的哈希，之后无法再显示。
      </p>
      <code className="reference">{token}</code>
      <div className="token-actions">
        <CopyButton text={token} label="复制凭据" />
        <a
          className="button-link"
          download={`${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-token.json`}
          href={
            'data:application/json;charset=utf-8,' + encodeURIComponent(file)
          }
        >
          下载凭据文件
        </a>
        <button type="button" className="quiet" onClick={onDismiss}>
          我已保存
        </button>
      </div>
      <p className="muted">{where}不要把它贴到聊天、日志或命令参数里。</p>
    </div>
  );
}
/**
 * The team's T3 connection, read again when the hub says it changed, such as
 * when a sign-in in T3 completes.
 */
export function useT3(teamId: string) {
  const [status, setStatus] = useState<T3Status | null>(null);
  const { begin, settle, drop, reads } = useLive();
  const load = useCallback(() => {
    begin('t3');
    void api(`/api/teams/${teamId}/t3`)
      .then((raw) => {
        const next = T3Status.parse(raw);
        setStatus(next);
        settle('t3', next.revision);
      })
      .catch(() => {
        setStatus(null);
        drop('t3');
      });
  }, [teamId, begin, settle, drop]);
  useEffect(load, [load, reads.t3]);
  useEffect(
    () => () => {
      drop('t3');
    },
    [drop],
  );
  return { status, load };
}
/** One thing to do now: the only control on screen until it is done. */
function NextStep({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="next-step" role="group" aria-label={title}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}
/**
 * A sign-in under way: the approval opens in T3. When T3's approval ends on
 * the person's own computer, its address is pasted here to finish.
 */
function Approve({
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
 * Connect the team to T3 once. The T3 desktop app on this machine is found
 * on its own; another T3 takes its MCP URL.
 */
function ConnectT3({
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
  const waiting = t3?.signIn === 'waiting' && approval !== null;
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
          url={approval}
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
  if (renewal.signIn === 'waiting' && approval !== null)
    return (
      <Approve
        teamId={teamId}
        url={approval}
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
/** Pick what the agent runs on, as one choice: provider and model together. */
function ChooseModel({
  agent,
  data,
  onDone,
  onCancel,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [offered, setOffered] = useState<
    z.infer<typeof Providers>['providers'] | 'unavailable' | null
  >(null);
  // T3 cannot say when its models change, so they are read again whenever
  // T3 is: on a new connection, Refresh now, or a network that comes back.
  const { reads } = useLive();
  useEffect(() => {
    void api(`/api/teams/${data.team.id}/t3/providers`)
      .then((raw) => {
        setOffered(
          Providers.parse(raw).providers.filter((p) => p.models.length > 0),
        );
      })
      .catch(() => {
        setOffered('unavailable');
      });
  }, [data.team.id, reads.t3]);
  const prefs = agent.preferences;
  const current =
    prefs.providerId && prefs.modelId
      ? prefs.providerId + '\n' + prefs.modelId
      : '';
  const title = `选择 ${agent.name} 使用的模型`;
  return (
    <NextStep title={title}>
      <form
        className="agent-connect"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const read = (key: string) => value(form, key).trim();
          const [providerId = '', modelId = ''] = read('model').includes('\n')
            ? read('model').split('\n')
            : [read('providerId'), read('modelId')];
          void send(`/api/teams/${data.team.id}/agents/${agent.id}/connect`, {
            providerId,
            modelId,
          }).then((ok) => {
            if (ok !== undefined) onDone();
          });
        }}
      >
        {offered === null ? (
          <p className="muted">正在询问 T3 能运行什么…</p>
        ) : offered === 'unavailable' ? (
          <p className="muted">现在连不上 T3。</p>
        ) : offered.length === 0 ? (
          <>
            <p className="muted">T3 没有列出模型，请按 T3 显示的名称填写。</p>
            <div className="field-row">
              <Field label="提供方">
                <input
                  name="providerId"
                  required
                  defaultValue={prefs.providerId ?? ''}
                />
              </Field>
              <Field label="模型">
                <input
                  name="modelId"
                  required
                  defaultValue={prefs.modelId ?? ''}
                />
              </Field>
            </div>
          </>
        ) : (
          <Field label="模型">
            <select
              name="model"
              required
              defaultValue={
                offered.some((p) =>
                  p.models.some((m) => p.id + '\n' + m === current),
                )
                  ? current
                  : undefined
              }
            >
              {offered.map((p) => (
                <optgroup key={p.id} label={p.id}>
                  {p.models.map((m) => (
                    <option key={m} value={p.id + '\n' + m}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
        )}
        <div className="token-actions">
          <button
            type="submit"
            disabled={
              !permitted ||
              busy ||
              offered === null ||
              offered === 'unavailable' ||
              agent.lifecycle !== 'active'
            }
          >
            {busy ? '正在连接…' : `连接 ${agent.name}`}
          </button>
          {onCancel && (
            <button type="button" className="quiet" onClick={onCancel}>
              保持不变
            </button>
          )}
        </div>
      </form>
      {error && <Notice>{error}</Notice>}
    </NextStep>
  );
}
/**
 * Optional: let the agent read and act in Kinmesh while it works (Team MCP).
 * Without it the agent still answers; its reply comes back as a message.
 */
function TeamMcp({ agent, data }: { agent: Agent; data: WorkspaceSnapshot }) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [token, setToken] = useState<string | null>(null);
  const seen = data.teamMcp.find((p) => p.agentId === agent.id)?.lastSeenAt;
  return (
    <div className="about-mcp">
      <dl>
        <dt>Team MCP</dt>
        <dd>{seen ? `${ago(seen)}连接过` : '未设置'}</dd>
      </dl>
      {token ? (
        <TokenOnce
          token={token}
          agent={agent}
          where={
            <>
              把它粘贴到 T3 中 {agent.name} 的提供方，作为{' '}
              <code>{TEAM_MCP_URL}</code> 上 Team MCP 的 bearer token。
            </>
          }
          onDismiss={() => {
            setToken(null);
          }}
        />
      ) : (
        <button
          type="button"
          className="secondary"
          disabled={!permitted || busy || agent.lifecycle !== 'active'}
          onClick={() => {
            void send(`/api/teams/${data.team.id}/agents/${agent.id}/grants`, {
              label: 'Team MCP',
              scopes: TEAM_MCP_SCOPES,
              lifetimeSeconds: 90 * 86400,
            }).then((raw) => {
              if (raw !== undefined) setToken(Issued.parse(raw).token);
            });
          }}
        >
          签发 Team MCP 凭据
        </button>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
/**
 * Running a worker by hand: the operator owns its configuration file and
 * credential. Kept for deployments where the hub doesn't run the worker.
 */
function OwnWorker({
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
                g.revokedAt === null && Date.parse(g.expiresAt) > Date.now();
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
/**
 * The agent's setup shows one thing at a time: the next step, or, once the
 * agent can be woken, a single line saying so. Every other fact is in About.
 */
export function AgentSetup({
  agent,
  data,
  t3,
  channelPath,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  t3: ReturnType<typeof useT3>;
  channelPath: string | null;
  onDone: () => void;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [changing, setChanging] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const joined = data.joinedAgentIds.includes(agent.id);
  const awake = workerConnected(data.wake, agent.id);
  const managed = managedOf(data, agent.id);
  const connection = t3.status?.connection ?? null;
  const t3Ready =
    connection !== null && connection.access !== 'read' && !connection.expired;
  const connectedAt = connection?.connectedAt;
  useEffect(() => {
    setReconnecting(false);
  }, [connectedAt]);
  const base = `/api/teams/${data.team.id}/agents/${agent.id}`;
  let next: ReactNode = null;
  if (agent.lifecycle !== 'active')
    next = <p className="muted">{agent.name} 已停用，无法唤醒。</p>;
  else if (t3.status === null) next = <p className="muted">正在查看 T3…</p>;
  else if (t3.status.provisioned && connection === null)
    next = <p className="muted">正在连接 T3…</p>;
  else if (!t3Ready || reconnecting)
    next = (
      <ConnectT3
        teamId={data.team.id}
        t3={t3.status}
        reload={t3.load}
        agentName={agent.name}
      />
    );
  else if (!managed || changing)
    next = (
      <ChooseModel
        agent={agent}
        data={data}
        onDone={() => {
          setChanging(false);
          onDone();
        }}
        {...(managed
          ? {
              onCancel: () => {
                setChanging(false);
              },
            }
          : {})}
      />
    );
  const where = connection && t3Where(connection);
  const t3Line = where && (
    <span className="muted">
      T3 {where.host}
      {where.access && `（${where.access}）`}
    </span>
  );
  return (
    <section className="agent-setup" aria-label="配置">
      {next ? (
        <>
          {next}
          {t3Ready && !reconnecting && (
            <p className="setup-t3">
              {t3Line}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setReconnecting(true);
                }}
              >
                重新连接
              </button>
            </p>
          )}
        </>
      ) : (
        <div className="setup-status" data-ready={awake ? 'true' : undefined}>
          <span className="setup-mark" aria-hidden="true" />
          <p>
            <strong>{awake ? '可以回复了' : '正在启动工作进程…'}</strong>
          </p>
          <span className="setup-actions">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setChanging(true);
              }}
            >
              更换模型
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setReconnecting(true);
              }}
            >
              重新连接
            </button>
            <button
              type="button"
              className="link-button subtle-danger"
              disabled={!permitted || busy}
              onClick={() => {
                void send(base + '/disconnect').then((ok) => {
                  if (ok !== undefined) onDone();
                });
              }}
            >
              断开连接
            </button>
          </span>
        </div>
      )}
      {error && <Notice>{error}</Notice>}
      {/* Membership is per channel, not a setup step: say it, offer the fix. */}
      {!joined && channelPath && agent.lifecycle === 'active' && (
        <div className="channel-note">
          <p className="muted">
            {agent.name} 不在这个频道，这里的提及它收不到。
          </p>
          <ActionForm
            title={'邀请 ' + agent.name}
            path={channelPath + '/participants/invite'}
            build={() => ({ member: { kind: 'agent', id: agent.id } })}
            onDone={onDone}
            submit={'把 ' + agent.name + ' 加入频道'}
          />
        </div>
      )}
    </section>
  );
}
/** A square, small picture from any image the browser can read. */
async function avatarFrom(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas');
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    256,
    256,
  );
  bitmap.close();
  for (const quality of [0.86, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((done) => {
      canvas.toBlob(done, 'image/webp', quality);
    });
    if (blob?.type === 'image/webp' && blob.size <= 120 * 1024) return blob;
  }
  const png = await new Promise<Blob | null>((done) => {
    canvas.toBlob(done, 'image/png');
  });
  if (!png || png.size > 120 * 1024) throw new Error('Too large');
  return png;
}
/** The agent's face: click it to choose a picture. */
function AvatarPicker({
  agent,
  data,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  onDone: () => void;
}) {
  const picture = useRequest({}, '这张图片没有成功，换一张试试。');
  const file = useRef<HTMLInputElement>(null);
  const has = data.avatars.some((a) => a.agentId === agent.id);
  const path = `/api/teams/${data.team.id}/agents/${agent.id}/avatar`;
  const send = (body: Blob | undefined, method: 'PUT' | 'DELETE') =>
    picture.send(path, body, method).then((done) => {
      if (done !== undefined) onDone();
    });
  return (
    <div className="avatar-picker">
      <button
        type="button"
        className="avatar-change"
        aria-label={`更换 ${agent.name} 的头像`}
        title="更换头像"
        disabled={picture.disabled}
        onClick={() => file.current?.click()}
      >
        <Avatar kind="agent" name={agent.name} id={agent.id} size="xl" />
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!chosen) return;
          void avatarFrom(chosen).then(
            (blob) => send(blob, 'PUT'),
            () => {
              picture.setError('Kinmesh 无法使用这个文件作为图片。');
            },
          );
        }}
      />
      {has && (
        <button
          type="button"
          className="link-button subtle-danger"
          disabled={picture.disabled}
          onClick={() => {
            void send(undefined, 'DELETE');
          }}
        >
          移除头像
        </button>
      )}
      {picture.error && <Notice>{picture.error}</Notice>}
    </div>
  );
}
/**
 * Everything else about the agent, every value in sight. The hand-run worker
 * is a task of its own, so it opens as its own page.
 */
export function AgentAbout({
  agent,
  data,
  t3,
  onOwnWorker,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  t3: ReturnType<typeof useT3>;
  onOwnWorker: () => void;
  onDone: () => void;
}) {
  const managed = managedOf(data, agent.id);
  const awake = workerConnected(data.wake, agent.id);
  const connection = t3.status?.connection ?? null;
  const where = connection && t3Where(connection);
  const provider = managed?.providerId ?? agent.preferences.providerId;
  return (
    <aside className="agent-about" aria-label="关于">
      <AvatarPicker agent={agent} data={data} onDone={onDone} />
      <dl>
        <dt>提供方</dt>
        <dd>{provider ?? '未选择'}</dd>
        <dt>模型</dt>
        <dd>{agent.preferences.modelId ?? '未选择'}</dd>
        <dt>T3</dt>
        <dd>
          {where
            ? [where.host, where.access].filter(Boolean).join(' · ')
            : '未连接'}
        </dd>
        <dt>工作进程</dt>
        <dd>{managed ? '由 Kinmesh 运行' : awake ? '由你运行' : '未运行'}</dd>
      </dl>
      <TeamMcp agent={agent} data={data} />
      <dl>
        <dt>智能体 ID</dt>
        <dd className="agent-id">
          <code className="reference" title={agent.id}>
            {agent.id}
          </code>
          <CopyButton text={agent.id} label="复制" className="link-button" />
        </dd>
        <dt>记忆</dt>
        <dd>{agent.memoryLocation ?? '无'}</dd>
      </dl>
      <button
        type="button"
        className="link-button about-link"
        onClick={onOwnWorker}
      >
        自己运行工作进程 →
      </button>
    </aside>
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
