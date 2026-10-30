import { useEffect, useState } from 'react';
import { ProfileInput } from '../src/domain/agents.js';
import type { Agent } from '../src/domain/agents.js';
import { decodeExecutionEvent } from '../src/workspace/contracts.js';
import type {
  ExecutionSnapshot,
  WorkspaceSnapshot,
} from '../src/workspace/contracts.js';
import { api, HttpError, value } from './api.js';
import { ActionForm, Field, Notice } from './forms.js';
function Activity({
  agent,
  teamId,
  revision,
}: {
  agent: Agent;
  teamId: string;
  revision: string;
}) {
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/agui/${teamId}/${agent.id}`, { signal: controller.signal })
      .then((raw) => {
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
      <h3>{agent.name} · Execution activity</h3>
      <p className="eyebrow">AG-UI 1.0 · refreshed snapshot</p>
      <p>
        Stored reports, not a live T3 feed. Reports may be stale; this page does
        not contact T3 or verify native status.
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
              <article className="execution" key={e.correlation.id}>
                <span className="badge">
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
                <button
                  disabled
                  title="No verified native launch URL is stored with this association."
                >
                  Open in T3 (link unavailable)
                </button>
                <p className="muted">
                  Use these references in your authorized T3 workspace. Kinmesh
                  does not invent a deep link.
                </p>
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
export function Agents({
  data,
  channelPath,
  onDone,
}: {
  data: WorkspaceSnapshot;
  channelPath: string | null;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const current = data.agents.find((a) => a.id === selected);
  return (
    <section>
      <div className="section-heading">
        <div>
          <p className="eyebrow">People’s partners, persistent by design</p>
          <h2>Team agents</h2>
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
      <div className="agent-grid">
        {data.agents.map((agent) => (
          <article className="agent-card" key={agent.id}>
            <div className="avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
            <h3>{agent.name}</h3>
            <p>
              {agent.role} · {agent.lifecycle}
            </p>
            <small className="reference">{agent.id}</small>
            <details>
              <summary>Profile details</summary>
              <dl>
                <dt>Environment preference</dt>
                <dd>{agent.preferences.environmentId ?? 'Not configured'}</dd>
                <dt>Provider preference</dt>
                <dd>{agent.preferences.providerId ?? 'Not configured'}</dd>
                <dt>Model preference</dt>
                <dd>{agent.preferences.modelId ?? 'Not configured'}</dd>
                <dt>Memory reference</dt>
                <dd>{agent.memoryLocation ?? 'None'}</dd>
              </dl>
              <p>
                Preferences are configuration, not proof of execution
                availability.
              </p>
            </details>
            <button
              className="quiet"
              onClick={() => {
                setSelected(agent.id);
              }}
            >
              View {agent.name} activity
            </button>
            {channelPath &&
              agent.lifecycle === 'active' &&
              (data.joinedAgentIds.includes(agent.id) ? (
                <span className="badge">Joined this channel</span>
              ) : (
                <ActionForm
                  title={'Enroll ' + agent.name}
                  path={channelPath + '/participants/invite'}
                  build={() => ({ member: { kind: 'agent', id: agent.id } })}
                  onDone={onDone}
                  submit={'Add ' + agent.name + ' to channel'}
                />
              ))}
          </article>
        ))}
      </div>
      {data.agents.length === 0 && (
        <p className="empty">
          Register a durable teammate, then enroll them in a channel.
        </p>
      )}
      {data.agentsTruncated && (
        <p>
          Showing the first 100 agents. Use the owner agent API for additional
          profiles.
        </p>
      )}
      {current && (
        <Activity
          key={current.id}
          agent={current}
          teamId={data.team.id}
          revision={data.observedAt}
        />
      )}
    </section>
  );
}
