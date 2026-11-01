import { useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { Grant, ProfileInput } from '../src/domain/agents.js';
import type { Agent, Scope } from '../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, HttpError, MutationPermission } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';
import { ago, wakeOf } from './ui.js';

/** Scopes the Inbox worker needs (docs/agent-inbox.md, step 2). */
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
});
type T3Status = z.infer<typeof T3Status>;
const Providers = z.object({
  providers: z.array(z.object({ id: z.string(), models: z.array(z.string()) })),
});
type Step = 'done' | 'todo' | 'manual';

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
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<'' | 'Copied' | 'Copy failed'>('');
  return (
    <button
      type="button"
      className="secondary"
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
/** One request at a time, with a plain error; the caller decides what follows. */
function useRequest() {
  const permitted = useContext(MutationPermission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(
    async (path: string, body?: unknown) => {
      if (!permitted || busy) return undefined;
      setBusy(true);
      setError('');
      try {
        return await api(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      } catch (cause) {
        setError(
          cause instanceof HttpError && cause.status === 409
            ? 'That no longer applies; the panel shows what changed.'
            : 'That did not go through. Nothing was changed; try again.',
        );
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [permitted, busy],
  );
  return { run, busy, error, permitted };
}
/** The team's T3 connection; polled while the owner approves it in T3. */
function useT3(teamId: string) {
  const [status, setStatus] = useState<T3Status | null>(null);
  const load = useCallback(() => {
    void api(`/api/teams/${teamId}/t3`)
      .then((raw) => {
        setStatus(T3Status.parse(raw));
      })
      .catch(() => {
        setStatus(null);
      });
  }, [teamId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (status?.signIn !== 'waiting') return;
    const timer = setInterval(load, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [status?.signIn, load]);
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
  const { run, busy, error, permitted } = useRequest();
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
    void run(`/api/teams/${teamId}/t3/connect`, {
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
            const typed = new FormData(event.currentTarget).get('endpoint');
            const endpoint =
              askForUrl && typeof typed === 'string' ? typed.trim() : local;
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
  const { run, busy, error, permitted } = useRequest();
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
          const read = (key: string) => {
            const v = form.get(key);
            return typeof v === 'string' ? v.trim() : '';
          };
          const [providerId = '', modelId = ''] = read('model').includes('\n')
            ? read('model').split('\n')
            : [read('providerId'), read('modelId')];
          void run(`/api/teams/${data.team.id}/agents/${agent.id}/connect`, {
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
        {Array.isArray(offered) && offered.length > 0 && (
          <p className="muted">
            Only models T3 can run now are listed. A provider switched off in T3
            appears once it’s on.
          </p>
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
  const { run, busy, error, permitted } = useRequest();
  const [token, setToken] = useState<string | null>(null);
  const seen = data.teamMcp.find((p) => p.agentId === agent.id)?.lastSeenAt;
  return (
    <div className="more-section">
      <p className="muted">
        {agent.name} answers without this. To let it also read the channel, take
        tasks and hand them on while it works, give its T3 provider Kinmesh’s
        Team MCP (<code>{TEAM_MCP_URL}</code> by default) and a credential of
        its own. Kinmesh never changes T3’s settings.
      </p>
      {seen && (
        <p className="muted">
          {agent.name} last reached Team MCP {ago(seen)}.
        </p>
      )}
      {token ? (
        <TokenOnce
          token={token}
          agent={agent}
          where={`Paste it into ${agent.name}’s provider in T3 as its Team MCP bearer token.`}
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
            void run(`/api/teams/${data.team.id}/agents/${agent.id}/grants`, {
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
  const { run, busy, error, permitted } = useRequest();
  const base = `/api/teams/${data.team.id}/agents/${agent.id}`;
  const [grants, setGrants] = useState<ListedGrant[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => {
    void api(base + '/grants')
      .then((raw) => {
        setGrants(z.array(ListedGrant).parse(raw));
      })
      .catch(() => {
        setLoadError('Credentials unavailable. Reopen this panel to retry.');
      });
  }, [base]);
  useEffect(load, [load]);
  const mutate = (path: string, body?: unknown) => {
    void run(path, body).then((raw) => {
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
              const read = (key: string) => {
                const v = f.get(key);
                return typeof v === 'string' && v.trim() ? v.trim() : null;
              };
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
            <p className="muted">
              A {LIFETIME_DAYS}-day credential with exactly the scopes the Inbox
              worker uses.
            </p>
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
                    <span className="grant-actions">
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
 * agent can be woken, a single line saying so. Everything else is in More.
 */
export function AgentSetup({
  agent,
  data,
  channelPath,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  channelPath: string | null;
  onDone: () => void;
}) {
  const t3 = useT3(data.team.id);
  const { run, busy, error, permitted } = useRequest();
  const [changing, setChanging] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const joined = data.joinedAgentIds.includes(agent.id);
  const awake = wakeOf(data.wake, agent.id).connected;
  const managed = data.managed.find((m) => m.agentId === agent.id) ?? null;
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
  return (
    <section className="agent-setup" aria-label="Setup">
      {next ?? (
        <div className="setup-status" data-ready={awake ? 'true' : undefined}>
          <span className="setup-mark" aria-hidden="true" />
          <p>
            <strong>
              {awake
                ? `${agent.name} is ready`
                : `Starting ${agent.name}’s worker…`}
            </strong>
            <span className="muted">
              {' '}
              Runs on {managed?.providerId} · {agent.preferences.modelId}
            </span>
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
              className="link-button subtle-danger"
              disabled={!permitted || busy}
              onClick={() => {
                void run(base + '/disconnect').then((ok) => {
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
      <details className="setup-details">
        <summary>More</summary>
        {connection && (
          <div className="more-section">
            <p className="muted">
              T3: {new URL(connection.endpoint).host} ·{' '}
              {connection.access === 'read' ? 'read only' : 'supervised'}
              {t3Ready && !reconnecting && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setReconnecting(true);
                    }}
                  >
                    Reconnect
                  </button>
                </>
              )}
            </p>
          </div>
        )}
        <details className="setup-details">
          <summary>Let {agent.name} act in Kinmesh while it works</summary>
          <TeamMcp agent={agent} data={data} />
        </details>
        <details className="setup-details own-worker">
          <summary>Run the worker yourself</summary>
          <OwnWorker
            agent={agent}
            data={data}
            managedGrantId={managed?.grantId ?? null}
            onDone={onDone}
          />
        </details>
      </details>
    </section>
  );
}
