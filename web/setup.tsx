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
    })
    .nullable(),
  signIn: z.enum(['waiting', 'failed']).nullable(),
  revision: z.string(),
});
type T3Status = z.infer<typeof T3Status>;
const Providers = z.object({
  providers: z.array(z.object({ id: z.string(), models: z.array(z.string()) })),
});
type Step = 'done' | 'todo' | 'manual';
type T3Connection = NonNullable<T3Status['connection']>;
/** Where the team's T3 is, and what it lets agents do there. */
function t3Where(connection: T3Connection) {
  return {
    host: new URL(connection.endpoint).host,
    access: connection.access === 'read' ? 'read only' : 'supervised',
  };
}
/** The worker Kinmesh runs for this agent, if it runs one. */
function managedOf(data: WorkspaceSnapshot, agentId: string) {
  return data.managed.find((m) => m.agentId === agentId) ?? null;
}
/** A setup request; a conflict means the page is behind what changed. */
const useSetupRequest = () =>
  useRequest({ 409: 'That no longer applies; the panel shows what changed.' });

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
            ? ' (done)'
            : step === 'manual'
              ? ' (outside Kinmesh)'
              : ' (to do)'}
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
  const [done, setDone] = useState<'' | 'Copied' | 'Copy failed'>('');
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setDone('Copied');
          },
          () => {
            setDone('Copy failed');
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
        <strong>Copy this credential now.</strong> Kinmesh stores only its hash
        and cannot show it again.
      </p>
      <code className="reference">{token}</code>
      <div className="token-actions">
        <CopyButton text={token} label="Copy token" />
        <a
          className="button-link"
          download={`${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-token.json`}
          href={
            'data:application/json;charset=utf-8,' + encodeURIComponent(file)
          }
        >
          Download token file
        </a>
        <button type="button" className="quiet" onClick={onDismiss}>
          I saved it
        </button>
      </div>
      <p className="muted">
        {where} Never paste it into chat, logs or command arguments.
      </p>
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
    <NextStep title={readOnly ? 'Give T3 permission to run' : 'Connect T3'}>
      <p className="muted">
        {readOnly
          ? `T3 only allowed reading, so ${agentName} can’t run there. Connect again and choose Supervised.`
          : local && !other
            ? `T3 is running on this Mac. Connect it once for the whole team.`
            : `Paste the MCP URL from T3: Settings → Environments → Copy MCP URL.`}
      </p>
      {waiting ? (
        <div className="approve">
          <a
            className="button-link"
            href={approval}
            target="_blank"
            rel="noopener noreferrer"
          >
            Approve in T3 ↗
          </a>
          <span className="muted" role="status">
            Waiting for your approval…
          </span>
          <ul className="approve-hints">
            <li>
              Choose <strong>Supervised</strong>, so {agentName} can run.
            </li>
            <li>
              Asked for a pairing code? Create one in T3 under Settings →
              Sharing &amp; access.
            </li>
          </ul>
        </div>
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
            <Field label="T3 MCP URL">
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
              {busy ? 'Starting…' : 'Connect T3'}
            </button>
            {local && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setOther((v) => !v);
                }}
              >
                {other ? 'Use T3 on this Mac' : 'Use another T3'}
              </button>
            )}
          </div>
        </form>
      )}
      {t3?.signIn === 'failed' && (
        <Notice>T3 didn’t approve the connection. Try again.</Notice>
      )}
      {error && <Notice>{error}</Notice>}
    </NextStep>
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
  }, [data.team.id]);
  const prefs = agent.preferences;
  const current =
    prefs.providerId && prefs.modelId
      ? prefs.providerId + '\n' + prefs.modelId
      : '';
  const title = `Choose what ${agent.name} runs on`;
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
          <p className="muted">Asking T3 what it can run…</p>
        ) : offered === 'unavailable' || offered.length === 0 ? (
          <>
            <p className="muted">
              T3 didn’t list its models; type them as T3 shows them.
            </p>
            <div className="field-row">
              <Field label="Provider">
                <input
                  name="providerId"
                  required
                  defaultValue={prefs.providerId ?? ''}
                />
              </Field>
              <Field label="Model">
                <input
                  name="modelId"
                  required
                  defaultValue={prefs.modelId ?? ''}
                />
              </Field>
            </div>
          </>
        ) : (
          <Field label="Model">
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
              agent.lifecycle !== 'active'
            }
          >
            {busy ? 'Connecting…' : `Connect ${agent.name}`}
          </button>
          {onCancel && (
            <button type="button" className="quiet" onClick={onCancel}>
              Keep current
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
        <dd>{seen ? `reached ${ago(seen)}` : 'not set up'}</dd>
      </dl>
      {token ? (
        <TokenOnce
          token={token}
          agent={agent}
          where={
            <>
              Paste it into {agent.name}’s provider in T3 as the bearer token
              for Team MCP at <code>{TEAM_MCP_URL}</code>.
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
          Issue Team MCP credential
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
        setLoadError('Credentials can’t be loaded right now.');
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
      <Row step={configured ? 'done' : 'todo'} title="Runtime preferences">
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
              Edit
            </button>
          </p>
        ) : (
          <ActionForm
            title="Runtime preferences"
            method="PUT"
            keyed={false}
            path={base}
            submit="Save preferences"
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
            <Field label="T3 environment ID">
              <input
                name="environmentId"
                required
                defaultValue={prefs.environmentId ?? ''}
              />
            </Field>
            <div className="field-row">
              <Field label="Isolated provider ID">
                <input
                  name="providerId"
                  required
                  defaultValue={prefs.providerId ?? ''}
                />
              </Field>
              <Field label="Model ID">
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
      <Row step={credential ? 'done' : 'todo'} title="Worker credential">
        {token && (
          <TokenOnce
            token={token}
            agent={agent}
            where={
              <>
                Save it as the worker’s <code>tokenFile</code> (mode 0600).
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
              Issue worker credential
            </button>
          </>
        )}
        {grants && grants.length > 0 && (
          <ul className="grant-list" aria-label="Credentials">
            {grants.map((g) => {
              const live =
                g.revokedAt === null && Date.parse(g.expiresAt) > Date.now();
              const hubs = g.id === managedGrantId;
              return (
                <li key={g.id} data-live={live ? 'true' : undefined}>
                  <span>
                    {g.label} ·{' '}
                    {g.revokedAt
                      ? 'revoked'
                      : live
                        ? 'expires ' +
                          new Date(g.expiresAt).toLocaleDateString()
                        : 'expired'}
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
                          Rotate
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
                        Revoke
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
      <Row step="manual" title="T3 access (on the worker machine)">
        <p className="muted">
          Approve the worker’s T3 OAuth access in a browser on that machine:{' '}
          <code>npm run t3:auth</code>.
        </p>
      </Row>
      <Row step="manual" title="Inbox worker binding">
        <p className="muted">
          Add this to the worker’s private <code>inbox.json</code> bindings,
          replacing the placeholders, then start the worker.
        </p>
        <pre className="binding-snippet">
          <code>{binding}</code>
        </pre>
        <CopyButton text={binding} label="Copy binding" />
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
  const t3Ready = connection !== null && connection.access !== 'read';
  const connectedAt = connection?.connectedAt;
  useEffect(() => {
    setReconnecting(false);
  }, [connectedAt]);
  const base = `/api/teams/${data.team.id}/agents/${agent.id}`;
  let next: ReactNode = null;
  if (agent.lifecycle !== 'active')
    next = (
      <p className="muted">{agent.name} is disabled, so it can’t be woken.</p>
    );
  else if (t3.status === null) next = <p className="muted">Checking T3…</p>;
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
      T3 {where.host} ({where.access})
    </span>
  );
  return (
    <section className="agent-setup" aria-label="Setup">
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
                Reconnect
              </button>
            </p>
          )}
        </>
      ) : (
        <div className="setup-status" data-ready={awake ? 'true' : undefined}>
          <span className="setup-mark" aria-hidden="true" />
          <p>
            <strong>
              {awake ? 'Ready to answer' : 'Starting the worker…'}
            </strong>
          </p>
          <span className="setup-actions">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setChanging(true);
              }}
            >
              Change model
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setReconnecting(true);
              }}
            >
              Reconnect
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
              Disconnect
            </button>
          </span>
        </div>
      )}
      {error && <Notice>{error}</Notice>}
      {/* Membership is per channel, not a setup step: say it, offer the fix. */}
      {!joined && channelPath && agent.lifecycle === 'active' && (
        <div className="channel-note">
          <p className="muted">
            {agent.name} isn’t in this channel, so mentions here won’t reach it.
          </p>
          <ActionForm
            title={'Enroll ' + agent.name}
            path={channelPath + '/participants/invite'}
            build={() => ({ member: { kind: 'agent', id: agent.id } })}
            onDone={onDone}
            submit={'Add ' + agent.name + ' to channel'}
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
  const picture = useRequest(
    {},
    'That picture didn’t go through. Try another one.',
  );
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
        aria-label={`Change ${agent.name}’s picture`}
        title="Change picture"
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
              picture.setError('That file isn’t a picture Kinmesh can use.');
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
          Remove picture
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
    <aside className="agent-about" aria-label="About">
      <AvatarPicker agent={agent} data={data} onDone={onDone} />
      <dl>
        <dt>Provider</dt>
        <dd>{provider ?? 'not chosen'}</dd>
        <dt>Model</dt>
        <dd>{agent.preferences.modelId ?? 'not chosen'}</dd>
        <dt>T3</dt>
        <dd>{where ? `${where.host} · ${where.access}` : 'not connected'}</dd>
        <dt>Worker</dt>
        <dd>
          {managed ? 'run by Kinmesh' : awake ? 'run by you' : 'not running'}
        </dd>
      </dl>
      <TeamMcp agent={agent} data={data} />
      <dl>
        <dt>Agent ID</dt>
        <dd className="agent-id">
          <code className="reference" title={agent.id}>
            {agent.id}
          </code>
          <CopyButton text={agent.id} label="Copy" className="link-button" />
        </dd>
        <dt>Memory</dt>
        <dd>{agent.memoryLocation ?? 'none'}</dd>
      </dl>
      <button
        type="button"
        className="link-button about-link"
        onClick={onOwnWorker}
      >
        Run the worker yourself →
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
    <Page label="Run the worker yourself" onClose={onClose}>
      <div className="page-body">
        <h2>Run {agent.name}’s worker yourself</h2>
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
