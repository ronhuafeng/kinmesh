import { useEffect, useRef, useState } from 'react';
import { ProfileInput } from '../src/domain/agents.js';
import type { Agent } from '../src/domain/agents.js';
import {
  decodeExecutionEvent,
  decodeNativeObservation,
} from '../src/workspace/contracts.js';
import type {
  NativeObservation,
  ExecutionSnapshot,
  WorkspaceSnapshot,
} from '../src/workspace/contracts.js';
import { api, HttpError, value } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';
import { Avatar, Drawer, shortTime } from './ui.js';
function NativeStatus({
  correlation,
  teamId,
  agentId,
  onAccessLoss,
  trustedOrigin,
}: {
  correlation: ExecutionSnapshot['executions'][number]['correlation'];
  teamId: string;
  agentId: string;
  onAccessLoss: () => void;
  trustedOrigin: string | null;
}) {
  const [observation, setObservation] = useState<NativeObservation | null>(
    null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function check() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setObservation(null);
    setError('');
    try {
      const raw = await api(
        `/api/teams/${teamId}/agents/${agentId}/executions/${correlation.id}/native`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      if (controller.signal.aborted) return;
      setObservation(
        decodeNativeObservation(raw, correlation.reference, trustedOrigin),
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setObservation(null);
      if (
        cause instanceof HttpError &&
        (cause.status === 401 || cause.status === 403)
      ) {
        onAccessLoss();
      } else {
        setError(
          'Native T3 status unavailable. The owner must configure an authorized observer, or retry when T3 is reachable.',
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      pending.current = null;
    }
  }
  return (
    <div className="native-status">
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          void check();
        }}
      >
        Check native status
      </button>
      <div role="status" aria-live="polite">
        {busy && <p>Checking native status…</p>}
        {error && <p>{error}</p>}
        {observation && (
          <>
            <p>
              {observation.status === 'unobserved'
                ? 'Native read at '
                : 'Native verified at '}
              {new Date(observation.observedAt).toLocaleString()}
            </p>
            <p>
              {correlation.reference.runId
                ? 'Exact Run status'
                : 'Thread status'}
              : {observation.status} ·{' '}
              {observation.terminal ? 'terminal' : 'nonterminal'}
            </p>
            {observation.status === 'unobserved' && (
              <p>
                This Run is outside the bounded recent Run history. Its status
                is unobserved.
              </p>
            )}
            <p>
              Thread pending requests: {observation.threadPendingRequests}{' '}
              (thread-scoped, not attributed to this Run).
            </p>
            <p>
              Provider: {observation.providerId ?? 'unobserved'} · Model:{' '}
              {observation.modelId ?? 'unobserved'}
            </p>
          </>
        )}
      </div>
      {observation?.verifiedUrl ? (
        <a
          href={observation.verifiedUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open verified T3 thread
        </a>
      ) : (
        <button
          disabled
          title="T3 has not returned a verified browser URL for this thread."
        >
          Open in T3 (link unavailable)
        </button>
      )}
      <p className="muted">
        Native checks are read-only. Kinmesh never guesses a T3 link or accepts
        tasks from a Run result.
      </p>
    </div>
  );
}
function Activity({
  agent,
  teamId,
  revision,
  trustedOrigin,
}: {
  agent: Agent;
  teamId: string;
  revision: string;
  trustedOrigin: string | null;
}) {
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const [error, setError] = useState('');
  const snapshotRequest = useRef<AbortController | null>(null);
  function loseAccess() {
    snapshotRequest.current?.abort();
    setSnapshot(null);
    setError(
      'Execution access no longer authorized. Sign in again or contact your team owner.',
    );
  }
  useEffect(() => {
    const controller = new AbortController();
    snapshotRequest.current = controller;
    void api(`/api/agui/${teamId}/${agent.id}`, { signal: controller.signal })
      .then((raw) => {
        if (controller.signal.aborted) return;
        setSnapshot(decodeExecutionEvent(raw));
        setError('');
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (
          cause instanceof HttpError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          // Never retain a formerly authorized execution snapshot after access loss.
          setSnapshot(null);
          setError(
            'Execution access no longer authorized. Sign in again or contact your team owner.',
          );
        } else {
          // A temporary transport/server outage does not certify a new snapshot.
          setError(
            'Execution snapshot unavailable. Use Reconnect / refresh to retry.',
          );
        }
      });
    return () => {
      controller.abort();
    };
  }, [agent.id, teamId, revision]);
  return (
    <section className="activity" aria-label={agent.name + ' activity'}>
      <div className="drawer-heading">
        <h3>Execution activity</h3>
        <span className="eyebrow">AG-UI 1.0 · refreshed snapshot</span>
      </div>
      <p className="muted">
        Stored reports may be stale. Last recorded status is an AG-UI snapshot.
        Check native status explicitly for a separate, fresh read from T3.
      </p>
      {error && <Notice>{error}</Notice>}
      {snapshot && (
        <>
          <small>
            Snapshot read at {new Date(snapshot.observedAt).toLocaleString()}
          </small>
          {snapshot.executions.length === 0 && (
            <p>No execution associations recorded.</p>
          )}
          {snapshot.executions.map((e) => {
            const latest = e.events.at(-1);
            return (
              <article
                className="execution"
                key={e.correlation.id}
                data-state={latest?.state ?? 'unknown'}
              >
                <span className="recorded-chip">
                  Last recorded: {latest?.state ?? 'unknown'}
                </span>
                <p>
                  {latest
                    ? 'Reported ' +
                      new Date(latest.createdAt).toLocaleString() +
                      ' by ' +
                      latest.author.kind
                    : 'No runtime observation recorded.'}
                </p>
                {e.events.length > 1 && (
                  <ol className="timeline" aria-label="Recorded states">
                    {e.events.slice(-6).map((event) => (
                      <li key={event.id} data-state={event.state}>
                        <time dateTime={event.createdAt}>
                          {shortTime(event.createdAt)}
                        </time>
                        <span>{event.state}</span>
                        <small>by {event.author.kind}</small>
                      </li>
                    ))}
                  </ol>
                )}
                <dl>
                  <dt>Environment</dt>
                  <dd>{e.correlation.reference.environmentId}</dd>
                  <dt>T3 Thread</dt>
                  <dd>{e.correlation.reference.threadId}</dd>
                  <dt>T3 Run</dt>
                  <dd>{e.correlation.reference.runId ?? 'No Run reference'}</dd>
                </dl>
                <p>
                  Association by {e.correlation.author.kind}. Execution does not
                  imply task acceptance.
                </p>
                <NativeStatus
                  correlation={e.correlation}
                  teamId={teamId}
                  agentId={agent.id}
                  onAccessLoss={loseAccess}
                  trustedOrigin={trustedOrigin}
                />
                {e.eventsTruncated && (
                  <p>Showing the latest 100 recorded reports.</p>
                )}
              </article>
            );
          })}
          {snapshot.executionsTruncated && (
            <p>
              Showing the latest 20 associations. Use the authenticated
              execution API for full history.
            </p>
          )}
        </>
      )}
    </section>
  );
}
export function AgentDrawer({
  agent,
  data,
  onClose,
  disabled,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  onClose: () => void;
  disabled: boolean;
}) {
  const joined = data.joinedAgentIds.includes(agent.id);
  return (
    <Drawer
      label={agent.name}
      onClose={onClose}
      className="agent-drawer"
      disabled={disabled}
    >
      <div className="drawer-body">
        <header className="identity">
          <Avatar kind="agent" name={agent.name} size="lg" />
          <div>
            <h2>{agent.name}</h2>
            <p>
              <span className="role-pill">{agent.role}</span>
              <span className="lifecycle-tag" data-lifecycle={agent.lifecycle}>
                {agent.lifecycle}
              </span>
            </p>
          </div>
        </header>
        <h3>Profile</h3>
        <dl className="profile-list">
          <dt>Agent ID</dt>
          <dd className="reference">{agent.id}</dd>
          <dt>Environment preference</dt>
          <dd>{agent.preferences.environmentId ?? 'Not configured'}</dd>
          <dt>Provider preference</dt>
          <dd>{agent.preferences.providerId ?? 'Not configured'}</dd>
          <dt>Model preference</dt>
          <dd>{agent.preferences.modelId ?? 'Not configured'}</dd>
          <dt>Memory reference</dt>
          <dd>{agent.memoryLocation ?? 'None'}</dd>
          <dt>This channel</dt>
          <dd>{joined ? 'Joined' : 'Not joined'}</dd>
        </dl>
        <p className="muted">
          Preferences are configuration, not proof of execution availability.
        </p>
        <Activity
          key={agent.id + (data.nativeT3Origin ?? '')}
          agent={agent}
          teamId={data.team.id}
          revision={data.observedAt}
          trustedOrigin={data.nativeT3Origin}
        />
      </div>
    </Drawer>
  );
}
export function Team({
  data,
  channelPath,
  onDone,
  openAgent,
  selected,
}: {
  data: WorkspaceSnapshot;
  channelPath: string | null;
  onDone: () => void;
  openAgent: (id: string) => void;
  selected: string | null;
}) {
  return (
    <section className="team-view" aria-label="Team">
      <div className="section-heading">
        <div>
          <h2>Team</h2>
          <span>
            1 human · {data.agents.length} agents · {data.joinedAgentIds.length}{' '}
            in this channel
          </span>
        </div>
      </div>
      <details className="create-panel">
        <summary>Register agent</summary>
        <ActionForm
          title="Agent profile"
          path={`/api/teams/${data.team.id}/agents`}
          onDone={onDone}
          submit="Register agent"
          keyed={false}
          build={(f) =>
            ProfileInput.parse({
              name: value(f, 'name'),
              role: value(f, 'role'),
              capabilities: [],
              preferences: {
                environmentId: null,
                providerId: null,
                modelId: null,
              },
              memoryLocation: null,
            })
          }
        >
          <Field label="Agent name">
            <input name="name" required maxLength={80} />
          </Field>
          <Field label="Role">
            <select name="role">
              <option value="developer">Developer</option>
              <option value="reviewer">Reviewer</option>
              <option value="assistant">Assistant</option>
            </select>
          </Field>
          <p>
            Profiles do not launch agents or grant provider access. Configure
            execution separately.
          </p>
        </ActionForm>
      </details>
      <ul className="roster">
        <li className="roster-row" data-kind="human">
          <Avatar kind="human" name={data.human.username} />
          <div className="roster-identity">
            <h3>{data.human.username}</h3>
            <p>Human owner · you · final acceptance</p>
          </div>
          <span className="member-state">Joined</span>
        </li>
        {data.agents.map((agent) => (
          <li
            key={agent.id}
            className="roster-row"
            data-kind="agent"
            data-selected={agent.id === selected ? 'true' : undefined}
            data-lifecycle={agent.lifecycle}
          >
            <Avatar kind="agent" name={agent.name} />
            <div className="roster-identity">
              <h3>{agent.name}</h3>
              <p>
                {agent.role} · {agent.lifecycle}
                {agent.preferences.modelId && (
                  <span className="reference">
                    {' '}
                    · {agent.preferences.providerId ?? 'provider'}/
                    {agent.preferences.modelId}
                  </span>
                )}
              </p>
            </div>
            <div className="roster-actions">
              {channelPath &&
                agent.lifecycle === 'active' &&
                (data.joinedAgentIds.includes(agent.id) ? (
                  <span className="member-state">Joined this channel</span>
                ) : (
                  <ActionForm
                    title={'Enroll ' + agent.name}
                    path={channelPath + '/participants/invite'}
                    build={() => ({ member: { kind: 'agent', id: agent.id } })}
                    onDone={onDone}
                    submit={'Add ' + agent.name + ' to channel'}
                  />
                ))}
              <button
                className="secondary"
                onClick={() => {
                  openAgent(agent.id);
                }}
              >
                View {agent.name} activity
              </button>
            </div>
          </li>
        ))}
      </ul>
      {data.agents.length === 0 && (
        <div className="empty">
          <h3>No agents yet</h3>
          <p>Register a durable teammate, then enroll them in a channel.</p>
        </div>
      )}
      {data.agentsTruncated && (
        <p className="muted">
          Showing the first 100 agents. Use the owner agent API for additional
          profiles.
        </p>
      )}
    </section>
  );
}
