import { useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { Grant, ProfileInput } from '../src/domain/agents.js';
import type { Agent, Scope } from '../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { api, MutationPermission } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';
import { wakeOf } from './ui.js';

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
const LIFETIME_DAYS = 30;
const ListedGrant = Grant.omit({ agentId: true, teamId: true });
type ListedGrant = z.infer<typeof ListedGrant>;
const Issued = z.object({ grant: ListedGrant.loose(), token: z.string() });
type Step = 'done' | 'todo' | 'manual';

function usable(grant: ListedGrant) {
  return (
    grant.revokedAt === null &&
    Date.parse(grant.expiresAt) > Date.now() &&
    WORKER_SCOPES.every((s) => grant.scopes.includes(s))
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
  onDismiss,
}: {
  token: string;
  agent: Agent;
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
        Save it as the worker’s <code>tokenFile</code> (mode 0600). Never paste
        it into chat, logs or command arguments.
      </p>
    </div>
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
  const permitted = useContext(MutationPermission);
  const base = `/api/teams/${data.team.id}/agents/${agent.id}`;
  const [grants, setGrants] = useState<ListedGrant[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => {
    void api(base + '/grants')
      .then((raw) => {
        setGrants(z.array(ListedGrant).parse(raw));
      })
      .catch(() => {
        setError('Credentials unavailable. Reopen this panel to retry.');
      });
  }, [base]);
  useEffect(load, [load]);
  async function mutate(path: string, body?: unknown) {
    if (!permitted || busy) return;
    setBusy(true);
    setError('');
    try {
      const raw = await api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (raw !== null) setToken(Issued.parse(raw).token);
      load();
    } catch {
      setError('That did not go through. Nothing was changed; try again.');
    } finally {
      setBusy(false);
    }
  }
  const issueInput = {
    label: 'Inbox worker',
    scopes: WORKER_SCOPES,
    lifetimeSeconds: LIFETIME_DAYS * 86400,
  };
  const joined = data.joinedAgentIds.includes(agent.id);
  const prefs = agent.preferences;
  const configured =
    prefs.environmentId !== null &&
    prefs.providerId !== null &&
    prefs.modelId !== null;
  const credential = grants?.find(usable);
  const connected = wakeOf(data.wake, agent.id).connected;
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
    <section className="agent-setup" aria-label="Setup">
      <div className="drawer-heading">
        <h3>Setup</h3>
        <span className="eyebrow">
          {connected ? 'Ready' : `What ${agent.name} still needs`}
        </span>
      </div>
      {error && <Notice>{error}</Notice>}
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
                onDismiss={() => {
                  setToken(null);
                }}
              />
            )}
            {!credential && !token && (
              <>
                <p className="muted">
                  A {LIFETIME_DAYS}-day credential with exactly the scopes the
                  Inbox worker uses.
                </p>
                <button
                  type="button"
                  disabled={!permitted || busy || agent.lifecycle !== 'active'}
                  onClick={() => {
                    void mutate(base + '/grants', issueInput);
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
                    g.revokedAt === null &&
                    Date.parse(g.expiresAt) > Date.now();
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
                          <button
                            type="button"
                            className="quiet"
                            disabled={!permitted || busy}
                            onClick={() => {
                              void mutate(
                                `${base}/grants/${g.id}/rotate`,
                                issueInput,
                              );
                            }}
                          >
                            Rotate
                          </button>
                          <button
                            type="button"
                            className="quiet subtle-danger"
                            disabled={!permitted || busy}
                            onClick={() => {
                              void mutate(`${base}/grants/${g.id}/revoke`);
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
          </Row>
          <Row step="manual" title="T3 access (on the worker machine)">
            <p className="muted">
              Approve the worker’s T3 OAuth access in a browser on that machine:{' '}
              <code>npm run t3:auth</code>. Kinmesh cannot see this step; the
              last check below confirms the whole chain.
            </p>
          </Row>
          <Row
            step={connected ? 'done' : 'manual'}
            title="Inbox worker binding"
          >
            <p className="muted">
              Add this to the worker’s private <code>inbox.json</code> bindings,
              replacing the placeholders, then start the worker.
            </p>
            <pre className="binding-snippet">
              <code>{binding}</code>
            </pre>
            <CopyButton text={binding} label="Copy binding" />
          </Row>
          <Row step={connected ? 'done' : 'todo'} title="Can be woken">
            <p className="muted">
              {connected
                ? `A worker is ready to wake ${agent.name}.`
                : `Turns ready once a worker with this binding is running.`}
            </p>
          </Row>
        </ol>
      </details>
    </section>
  );
}
