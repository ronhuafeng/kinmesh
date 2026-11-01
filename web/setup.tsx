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
function T3Step({
  teamId,
  t3,
  reload,
}: {
  teamId: string;
  t3: T3Status | null;
  reload: () => void;
}) {
  const { run, busy, error, permitted } = useRequest();
  const [approval, setApproval] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const connection = t3?.connection ?? null;
  const connectedAt = connection?.connectedAt;
  useEffect(() => {
    setReplacing(false);
    setApproval(null);
  }, [connectedAt]);
  if (connection && !replacing)
    return (
      <Row step="done" title="T3 connected">
        <p className="muted">
          {new URL(connection.endpoint).host} · environment{' '}
          {connection.environmentId} ·{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setReplacing(true);
            }}
          >
            Reconnect
          </button>
        </p>
      </Row>
    );
  const waiting = t3?.signIn === 'waiting' && approval !== null;
  return (
    <Row step="todo" title="Connect T3">
      <p className="muted">
        One approval for the whole team. In T3, choose Read only or Supervised,
        never Full access.
      </p>
      <form
        className="t3-connect"
        onSubmit={(event) => {
          event.preventDefault();
          const endpoint = new FormData(event.currentTarget).get('endpoint');
          void run(`/api/teams/${teamId}/t3/connect`, {
            endpoint: typeof endpoint === 'string' ? endpoint.trim() : '',
            replace: connection !== null,
          }).then((raw) => {
            if (raw === undefined) return;
            setApproval(
              z.object({ authorizationUrl: z.string().nullable() }).parse(raw)
                .authorizationUrl,
            );
            reload();
          });
        }}
      >
        <Field
          label="T3 MCP URL"
          hint="In T3: Settings → Environments → Copy MCP URL"
        >
          <input
            name="endpoint"
            type="url"
            required
            placeholder="https://t3.example/mcp"
            defaultValue={connection?.endpoint ?? ''}
          />
        </Field>
        <div className="token-actions">
          <button type="submit" disabled={!permitted || busy || waiting}>
            {busy ? 'Starting…' : 'Connect T3'}
          </button>
          {waiting && (
            <>
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
            </>
          )}
        </div>
      </form>
      {t3?.signIn === 'failed' && (
        <Notice>T3 didn’t approve the connection. Try again.</Notice>
      )}
      {error && <Notice>{error}</Notice>}
      <details className="technical">
        <summary>Technical details</summary>
        <p>
          The approval returns to this machine (127.0.0.1:49871), so approve in
          a browser on the computer running Kinmesh. Otherwise run{' '}
          <code>npm run t3:auth</code> there. The credential is saved in
          Kinmesh’s private directory, never in the browser.
        </p>
      </details>
    </Row>
  );
}
function ProviderStep({
  agent,
  data,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
}) {
  const { run, busy, error, permitted } = useRequest();
  const [token, setToken] = useState<string | null>(null);
  const seen = data.teamMcp.find((p) => p.agentId === agent.id)?.lastSeenAt;
  return (
    <Row
      step={seen ? 'done' : 'manual'}
      title={`${agent.name}’s provider in T3`}
    >
      <p className="muted">
        In T3, give {agent.name} an isolated provider that uses Kinmesh’s Team
        MCP (<code>{TEAM_MCP_URL}</code> by default) with its own credential.
        Kinmesh never changes T3’s settings.
      </p>
      <p className="muted">
        {seen
          ? `${agent.name} reached Team MCP ${ago(seen)}.`
          : `This turns done the first time ${agent.name} reaches Team MCP.`}
      </p>
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
        <div className="token-actions">
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
        </div>
      )}
      {error && <Notice>{error}</Notice>}
    </Row>
  );
}
function ConnectStep({
  agent,
  data,
  t3,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  t3: T3Status | null;
  onDone: () => void;
}) {
  const { run, busy, error, permitted } = useRequest();
  const managed = data.managed.find((m) => m.agentId === agent.id);
  const [changing, setChanging] = useState(false);
  const [offered, setOffered] = useState<
    z.infer<typeof Providers>['providers'] | 'unavailable' | null
  >(null);
  const [provider, setProvider] = useState('');
  const connected = t3?.connection != null;
  const choosing = connected && (!managed || changing);
  const base = `/api/teams/${data.team.id}/agents/${agent.id}`;
  useEffect(() => {
    if (!choosing) return;
    void api(`/api/teams/${data.team.id}/t3/providers`)
      .then((raw) => {
        const list = Providers.parse(raw).providers;
        setOffered(list);
        setProvider(
          (current) =>
            current ||
            (list.find((p) => p.id === agent.preferences.providerId)?.id ??
              list[0]?.id ??
              ''),
        );
      })
      .catch(() => {
        setOffered('unavailable');
      });
  }, [choosing, data.team.id, agent.preferences.providerId]);
  const title = `Connect ${agent.name}`;
  if (managed && !changing)
    return (
      <Row step="done" title={`${agent.name} is connected`}>
        <p className="muted">
          Runs on {managed.providerId} · {agent.preferences.modelId} ·{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setChanging(true);
            }}
          >
            Change
          </button>{' '}
          ·{' '}
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
        </p>
        {error && <Notice>{error}</Notice>}
      </Row>
    );
  if (!connected)
    return (
      <Row step="todo" title={title}>
        <p className="muted">Connect T3 first.</p>
      </Row>
    );
  const models =
    offered !== null && offered !== 'unavailable'
      ? (offered.find((p) => p.id === provider)?.models ?? [])
      : [];
  return (
    <Row step="todo" title={title}>
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
          void run(base + '/connect', {
            providerId: read('providerId'),
            modelId: read('modelId'),
            providerConfigured: form.get('providerConfigured') === 'on',
          }).then((ok) => {
            if (ok === undefined) return;
            setChanging(false);
            onDone();
          });
        }}
      >
        {offered === null ? (
          <p className="muted">Reading providers from T3…</p>
        ) : offered === 'unavailable' ? (
          <>
            <p className="muted">
              T3 didn’t list its providers; type them as T3 shows them.
            </p>
            <div className="field-row">
              <Field label="Provider">
                <input name="providerId" required />
              </Field>
              <Field label="Model">
                <input name="modelId" required />
              </Field>
            </div>
          </>
        ) : (
          <div className="field-row">
            <Field label="Provider">
              <select
                name="providerId"
                required
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                }}
              >
                {offered.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <select
                name="modelId"
                required
                key={provider}
                defaultValue={
                  models.includes(agent.preferences.modelId ?? '')
                    ? (agent.preferences.modelId ?? '')
                    : models[0]
                }
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        <label className="check">
          <input type="checkbox" name="providerConfigured" required />
          This provider is {agent.name}’s, set up in T3 as described above
        </label>
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
            {busy ? 'Connecting…' : title}
          </button>
          {changing && (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setChanging(false);
              }}
            >
              Keep current
            </button>
          )}
        </div>
      </form>
      {error && <Notice>{error}</Notice>}
    </Row>
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
  const joined = data.joinedAgentIds.includes(agent.id);
  const connected = wakeOf(data.wake, agent.id).connected;
  const managed = data.managed.find((m) => m.agentId === agent.id) ?? null;
  return (
    <section className="agent-setup" aria-label="Setup">
      <div className="drawer-heading">
        <h3>Setup</h3>
        <span className="eyebrow">
          {connected ? 'Ready' : `What ${agent.name} still needs`}
        </span>
      </div>
      {/* A working agent needs no checklist in front; it stays one click away. */}
      <details className="setup-details" open={!connected}>
        <summary>{connected ? 'Show setup' : 'Setup steps'}</summary>
        <ol className="setup-steps">
          <Row step={joined ? 'done' : 'todo'} title="Joined this channel">
            {!joined && channelPath && agent.lifecycle === 'active' && (
              <ActionForm
                title={'Enroll ' + agent.name}
                path={channelPath + '/participants/invite'}
                build={() => ({ member: { kind: 'agent', id: agent.id } })}
                onDone={onDone}
                submit={'Add ' + agent.name + ' to channel'}
              />
            )}
          </Row>
          <T3Step teamId={data.team.id} t3={t3.status} reload={t3.load} />
          <ProviderStep agent={agent} data={data} />
          <ConnectStep
            agent={agent}
            data={data}
            t3={t3.status}
            onDone={onDone}
          />
          <Row step={connected ? 'done' : 'todo'} title="Can be woken">
            <p className="muted">
              {connected
                ? `A worker is ready to wake ${agent.name}.`
                : managed
                  ? `Kinmesh is starting ${agent.name}’s worker…`
                  : `Turns ready once ${agent.name} is connected.`}
            </p>
          </Row>
        </ol>
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
