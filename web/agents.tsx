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
import { ago, Avatar, Drawer, shortTime, WakeLabel, wakeOf } from './ui.js';
import { DeliveryLine } from './deliveries.js';
import { AgentSetup } from './setup.js';
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
          'T3 can’t be checked right now. The team owner can set up a T3 observer, or try again when T3 is reachable.',
        );
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      pending.current = null;
    }
  }
  const subject = correlation.reference.runId ? 'This run' : 'This thread';
  return (
    <div className="native-status">
      <button
        type="button"
        className="secondary"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          void check();
        }}
      >
        Check in T3
      </button>
      <div role="status" aria-live="polite">
        {busy && <p>Checking T3…</p>}
        {error && <p>{error}</p>}
        {observation &&
          (observation.status === 'unobserved' ? (
            <p>
              T3 checked at{' '}
              {new Date(observation.observedAt).toLocaleTimeString()}, but this
              run is older than its recent history, so its status is unknown.
            </p>
          ) : (
            <>
              <p>
                T3 confirms (checked{' '}
                {new Date(observation.observedAt).toLocaleTimeString()})
              </p>
              <p>
                {subject}: {observation.status} ·{' '}
                {observation.terminal ? 'finished' : 'still going'}
              </p>
            </>
          ))}
        {observation && (
          <>
            <p title="Counted for the whole T3 thread, not only this run.">
              Open requests in this thread: {observation.threadPendingRequests}
            </p>
            <p>
              Model: {observation.providerId ?? 'not reported'} ·{' '}
              {observation.modelId ?? 'not reported'}
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
          Open in T3
        </a>
      ) : (
        <button
          disabled
          title="T3 has not returned a verified link for this thread."
        >
          Open in T3 (no verified link)
        </button>
      )}
      <p className="muted">
        Checking is read-only. Kinmesh never guesses a T3 link, and a finished
        run never accepts a task.
      </p>
    </div>
  );
}
/** What a person calls each recorded runtime state. */
const reported: Record<string, string> = {
  unknown: 'unknown',
  active: 'working',
  waiting: 'waiting',
  succeeded: 'finished',
  failed: 'failed',
  stopped: 'stopped',
};
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
      'You no longer have access to this activity. Sign in again or ask the team owner.',
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
            'You no longer have access to this activity. Sign in again or ask the team owner.',
          );
        } else {
          // A temporary transport/server outage does not certify a new snapshot.
          setError(
            'Activity can’t be loaded right now. It will try again on the next refresh.',
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
        <h3>Activity</h3>
      </div>
      <p className="muted">
        What {agent.name} last reported. “Check in T3” asks T3 directly.
      </p>
      {error && <Notice>{error}</Notice>}
      {snapshot && (
        <>
          {snapshot.executions.length === 0 && (
            <p className="muted">No runs linked to {agent.name} yet.</p>
          )}
          {snapshot.executions.map((e) => {
            const latest = e.events.at(-1);
            const by = (kind: string) =>
              kind === 'agent' ? agent.name : 'a person';
            return (
              <article
                className="execution"
                key={e.correlation.id}
                data-state={latest?.state ?? 'unknown'}
              >
                <span className="recorded-chip">
                  Last reported: {reported[latest?.state ?? 'unknown']}
                </span>
                <p>
                  {latest
                    ? `${ago(latest.createdAt)} · reported by ${by(latest.author.kind)}`
                    : 'Nothing reported yet.'}
                </p>
                {e.events.length > 1 && (
                  <ol className="timeline" aria-label="Reports">
                    {e.events.slice(-6).map((event) => (
                      <li key={event.id} data-state={event.state}>
                        <time dateTime={event.createdAt}>
                          {shortTime(event.createdAt)}
                        </time>
                        <span>{reported[event.state]}</span>
                        <small>by {by(event.author.kind)}</small>
                      </li>
                    ))}
                  </ol>
                )}
                <NativeStatus
                  correlation={e.correlation}
                  teamId={teamId}
                  agentId={agent.id}
                  onAccessLoss={loseAccess}
                  trustedOrigin={trustedOrigin}
                />
                <details className="technical">
                  <summary>Technical details</summary>
                  <dl>
                    <dt>Environment</dt>
                    <dd>{e.correlation.reference.environmentId}</dd>
                    <dt>T3 thread</dt>
                    <dd>{e.correlation.reference.threadId}</dd>
                    <dt>T3 run</dt>
                    <dd>{e.correlation.reference.runId ?? 'none recorded'}</dd>
                  </dl>
                  <p>
                    Linked by {e.correlation.author.kind}. Linking a run never
                    accepts a task. Reports are AG-UI 1.0 state snapshots, read{' '}
                    {new Date(snapshot.observedAt).toLocaleTimeString()}.
                  </p>
                  {e.eventsTruncated && <p>Showing the latest 100 reports.</p>}
                </details>
              </article>
            );
          })}
          {snapshot.executionsTruncated && (
            <p className="muted">Showing the latest 20 runs.</p>
          )}
        </>
      )}
    </section>
  );
}
export function AgentDrawer({
  agent,
  data,
  channelPath,
  onDone,
  onClose,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  channelPath: string | null;
  onDone: () => void;
  onClose: () => void;
}) {
  return (
    <Drawer label={agent.name} onClose={onClose} className="agent-drawer">
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
            <WakeLabel wake={data.wake} agentId={agent.id} />
          </div>
        </header>
        <AgentSetup
          agent={agent}
          data={data}
          channelPath={channelPath}
          onDone={onDone}
        />
        {data.deliveries.some((d) => d.agentId === agent.id) && (
          <>
            <h3>Recent requests in this channel</h3>
            <ul className="deliveries" aria-label="Recent requests">
              {data.deliveries
                .filter((d) => d.agentId === agent.id)
                .slice(-5)
                .reverse()
                .map((d) => (
                  <DeliveryLine key={d.id} delivery={d} data={data} />
                ))}
            </ul>
          </>
        )}
        <Activity
          key={agent.id + (data.nativeT3Origin ?? '')}
          agent={agent}
          teamId={data.team.id}
          revision={data.observedAt}
          trustedOrigin={data.nativeT3Origin}
        />
        <details className="technical">
          <summary>Technical details</summary>
          <dl className="profile-list">
            <dt>Agent ID</dt>
            <dd className="reference">{agent.id}</dd>
            <dt>Memory reference</dt>
            <dd>{agent.memoryLocation ?? 'none'}</dd>
          </dl>
        </details>
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
            After registering, open the agent to finish its setup: a worker
            credential and an Inbox worker binding, so mentions can wake it.
          </p>
        </ActionForm>
      </details>
      {data.agents.length > 0 &&
        !data.agents.some((a) => wakeOf(data.wake, a.id).connected) && (
          <p className="roster-note">
            No agent can be woken yet. Mentions are kept, but nobody will act on
            them until an Inbox worker is running for that agent.
          </p>
        )}
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
              <WakeLabel wake={data.wake} agentId={agent.id} />
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
