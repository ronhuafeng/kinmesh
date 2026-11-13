import { useEffect, useRef, useState } from 'react';
import { Agent, ProfileInput } from '../src/domain/agents.js';
import {
  decodeExecutionEvent,
  decodeNativeObservation,
} from '../src/workspace/contracts.js';
import type {
  NativeObservation,
  ExecutionSnapshot,
  WorkspaceSnapshot,
} from '../src/workspace/contracts.js';
import { api, HttpError, request, useRequest, value } from './api.js';
import { ActionForm, Notice } from './forms.js';
import { ArrowIcon, PlusIcon } from './icons.js';
import { ago, Avatar, Page, Presence, workerConnected } from './ui.js';
import { deliveryText, Recovery } from './deliveries.js';
import type { DeliveryView } from './deliveries.js';
import { AgentAbout, AgentSetup, useT3 } from './setup.js';
import { plainLine } from './tasks.js';
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
          'T3 can’t be checked right now. Try again when T3 is reachable.',
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
      <span className="run-actions" role="cell">
        {/* Checking reads the team's T3 connection; before Connect T3 there
            is nothing to check with, so it isn't offered. */}
        {trustedOrigin && (
          <button
            type="button"
            className="link-button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => {
              void check();
            }}
          >
            Check in T3
          </button>
        )}
        {observation?.verifiedUrl && (
          <a
            href={observation.verifiedUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in T3
          </a>
        )}
      </span>
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
    </div>
  );
}
/** What a person calls each recorded runtime state. */
const reported: Record<string, string> = {
  unknown: 'Unknown',
  active: 'Working',
  waiting: 'Waiting',
  succeeded: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
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
      <h3>Runs</h3>
      {error && <Notice>{error}</Notice>}
      {snapshot && (
        <>
          {snapshot.executions.length === 0 && (
            <p className="muted">No runs yet.</p>
          )}
          {snapshot.executions.length > 0 && (
            <div className="runs" role="table" aria-label="Runs">
              <div className="run-head" role="row">
                <span role="columnheader">Status</span>
                <span role="columnheader">Time</span>
                <span role="columnheader">By</span>
                <span role="columnheader">T3 thread</span>
                <span role="columnheader">T3 run</span>
                <span role="columnheader">
                  <span className="visually-hidden">Check</span>
                </span>
              </div>
              {snapshot.executions.map((e) => {
                const latest = e.events.at(-1);
                const by = (kind: string) =>
                  kind === 'agent' ? agent.name : 'a person';
                const ref = e.correlation.reference;
                return (
                  <div
                    className="execution"
                    role="row"
                    key={e.correlation.id}
                    data-state={latest?.state ?? 'unknown'}
                  >
                    <span role="cell" className="run-state">
                      {reported[latest?.state ?? 'unknown']}
                    </span>
                    <span role="cell" className="run-time">
                      {latest ? (
                        <time
                          dateTime={latest.createdAt}
                          title={new Date(latest.createdAt).toLocaleString()}
                        >
                          {ago(latest.createdAt)}
                        </time>
                      ) : (
                        '—'
                      )}
                    </span>
                    <span role="cell" className="run-by">
                      {latest ? 'by ' + by(latest.author.kind) : '—'}
                    </span>
                    <code
                      role="cell"
                      className="run-ref"
                      title={`${ref.threadId} · environment ${ref.environmentId}`}
                    >
                      {ref.threadId}
                    </code>
                    <code
                      role="cell"
                      className="run-ref"
                      title={ref.runId ?? undefined}
                    >
                      {ref.runId ?? 'none recorded'}
                    </code>
                    <NativeStatus
                      correlation={e.correlation}
                      teamId={teamId}
                      agentId={agent.id}
                      onAccessLoss={loseAccess}
                      trustedOrigin={trustedOrigin}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {snapshot.executionsTruncated && (
            <p className="muted">Showing the latest 20 runs.</p>
          )}
        </>
      )}
    </section>
  );
}
/** An agent's own page: who it is, whether it can be woken, what it did. */
export function AgentPage({
  agent,
  data,
  channelPath,
  onBack,
  onReply,
  onOwnWorker,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  channelPath: string | null;
  onBack: () => void;
  onReply: (messageId: string) => void;
  onOwnWorker: () => void;
  onDone: () => void;
}) {
  const t3 = useT3(data.team.id);
  return (
    <Page label={agent.name} onClose={onBack} className="agent-page">
      <div className="agent-layout">
        <div className="agent-main">
          <AgentSetup
            agent={agent}
            data={data}
            t3={t3}
            channelPath={channelPath}
            onDone={onDone}
          />
          <Requests
            agent={agent}
            data={data}
            onReply={onReply}
            onDone={onDone}
          />
        </div>
        <AgentAbout
          agent={agent}
          data={data}
          t3={t3}
          onOwnWorker={onOwnWorker}
          onDone={onDone}
        />
      </div>
      {/* The longest list, so it comes last and takes the full width. */}
      <Activity
        key={agent.id + (data.nativeT3Origin ?? '')}
        agent={agent}
        teamId={data.team.id}
        revision={data.observedAt}
        trustedOrigin={data.nativeT3Origin}
      />
    </Page>
  );
}
/** What was asked of the agent here, what came of it, and where the answer is. */
function Requests({
  agent,
  data,
  onReply,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  onReply: (messageId: string) => void;
  onDone: () => void;
}) {
  const requests = data.deliveries
    .filter((d) => d.agentId === agent.id)
    .reverse();
  if (requests.length === 0) return null;
  const connected = workerConnected(data.wake, agent.id);
  const asked = (d: DeliveryView) => {
    const message = data.messages.items.find((m) => m.id === d.messageId);
    if (message) {
      const line = plainLine(message.body.trim().split('\n')[0] ?? '');
      return line.length > 60 ? line.slice(0, 57) + '…' : line;
    }
    return data.tasks.items.find((t) => t.id === d.taskId)?.title ?? null;
  };
  return (
    <section aria-label="Requests">
      <h3>Requests in this channel</h3>
      <ul className="requests">
        {requests.slice(0, 5).map((d) => {
          const { text, tone } = deliveryText(d, agent.name, connected);
          // On the agent's own page its name goes without saying.
          const outcome = text.startsWith(agent.name + ' ')
            ? text.slice(agent.name.length + 1)
            : text;
          const what = asked(d);
          const when = d.updatedAt ?? d.queuedAt;
          const reply = d.resultMessageId;
          const onPage =
            reply !== null && data.messages.items.some((m) => m.id === reply);
          return (
            <li
              key={d.id}
              className="request"
              data-tone={tone}
              title={`${d.state} · ${d.reason}`}
            >
              <span className="request-text">
                {what ? `“${what}”` : 'A request'}
              </span>
              <span className="request-outcome">{outcome}</span>
              <span className="request-time">{when ? ago(when) : ''}</span>
              {onPage ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    onReply(reply);
                  }}
                >
                  View reply
                </button>
              ) : (
                <span />
              )}
              {d.state === 'blocked' && (
                <div className="request-fix">
                  <Recovery
                    delivery={d}
                    data={data}
                    channelId={data.channel?.id ?? ''}
                    onDone={onDone}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
/**
 * Register an agent in its own tile: a name and a role. Registered from a
 * channel, it joins that channel, and its page opens on the next step.
 */
function RegisterAgent({
  teamId,
  channelPath,
  onClose,
  onRegistered,
}: {
  teamId: string;
  channelPath: string | null;
  onClose: () => void;
  onRegistered: (id: string) => void;
}) {
  const register = useRequest(
    { 409: 'An agent with that name already exists.' },
    'That did not go through. Try again.',
  );
  const [name, setName] = useState('');
  return (
    <form
      className="new-agent"
      aria-label="Agent profile"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void register
          .run(async () => {
            const agent = Agent.parse(
              await request(
                `/api/teams/${teamId}/agents`,
                ProfileInput.parse({
                  name: value(form, 'name').trim(),
                  role: value(form, 'role'),
                  capabilities: [],
                  preferences: {
                    environmentId: null,
                    providerId: null,
                    modelId: null,
                  },
                  memoryLocation: null,
                }),
              ),
            );
            if (channelPath)
              await request(channelPath + '/participants/invite', {
                operationKey: crypto.randomUUID(),
                member: { kind: 'agent', id: agent.id },
              });
            return agent.id;
          })
          .then((id) => {
            if (id !== undefined) onRegistered(id);
          });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
      // Leaving an empty tile puts the "+" back.
      onBlur={(event) => {
        if (
          name.trim() === '' &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          onClose();
      }}
    >
      {/* The tile is the agent to be: its face fills in as it is named. */}
      <span
        className="new-agent-face"
        data-named={name.trim() ? 'true' : undefined}
        aria-hidden="true"
      >
        {name.trim() ? (
          <Avatar kind="agent" name={name.trim()} size="xl" />
        ) : (
          <PlusIcon />
        )}
      </span>
      <span className="new-agent-name">
        <input
          name="name"
          aria-label="Agent name"
          placeholder="Name"
          required
          maxLength={80}
          autoFocus
          autoComplete="off"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            register.setError('');
          }}
        />
        <button
          type="submit"
          className="icon-button confirm new-agent-go"
          aria-label="Register agent"
          aria-busy={register.busy}
          disabled={register.disabled || name.trim() === ''}
        >
          <ArrowIcon />
        </button>
      </span>
      <select
        name="role"
        className="new-agent-role"
        aria-label="Role"
        defaultValue="developer"
      >
        <option value="developer">Developer</option>
        <option value="reviewer">Reviewer</option>
        <option value="assistant">Assistant</option>
      </select>
      {register.error && (
        <p className="new-agent-error" role="alert">
          {register.error}
        </p>
      )}
    </form>
  );
}
export function Team({
  data,
  channelPath,
  onDone,
  openAgent,
}: {
  data: WorkspaceSnapshot;
  channelPath: string | null;
  onDone: () => void;
  openAgent: (id: string) => void;
}) {
  const [registering, setRegistering] = useState(false);
  return (
    <section aria-label="Team">
      {/* Everyone as a tile, like a meeting's gallery: a face, a name, and
          whether they are here. An agent's tile opens its page; the last
          tile adds an agent. */}
      <ul className="roster" aria-label="Team">
        <li className="roster-tile" data-kind="human">
          <span className="roster-person">
            <Avatar kind="human" name={data.human.username} size="xl" />
            <span className="roster-name">{data.human.username}</span>
            {/* You are the one looking. */}
            <Presence online />
          </span>
        </li>
        {data.agents.map((agent) => {
          const awake = workerConnected(data.wake, agent.id);
          return (
            <li
              key={agent.id}
              className="roster-tile"
              data-kind="agent"
              data-lifecycle={agent.lifecycle}
            >
              <button
                type="button"
                className="roster-person"
                onClick={() => {
                  openAgent(agent.id);
                }}
              >
                <Avatar
                  kind="agent"
                  name={agent.name}
                  id={agent.id}
                  size="xl"
                />
                <span className="roster-name">{agent.name}</span>
                {/* Online: a worker is connected, so a mention wakes it. */}
                <Presence online={awake} />
              </button>
              {/* Membership is in the sidebar; only a missing one needs a fix. */}
              {channelPath &&
                agent.lifecycle === 'active' &&
                !data.joinedAgentIds.includes(agent.id) && (
                  <ActionForm
                    title={'Enroll ' + agent.name}
                    path={channelPath + '/participants/invite'}
                    build={() => ({ member: { kind: 'agent', id: agent.id } })}
                    onDone={onDone}
                    submit={'Add ' + agent.name + ' to channel'}
                  />
                )}
            </li>
          );
        })}
        <li className="roster-tile roster-add">
          {registering ? (
            <RegisterAgent
              teamId={data.team.id}
              channelPath={channelPath}
              onClose={() => {
                setRegistering(false);
              }}
              onRegistered={(id) => {
                setRegistering(false);
                onDone();
                openAgent(id);
              }}
            />
          ) : (
            <button
              type="button"
              className="roster-person"
              aria-label="Register agent"
              onClick={() => {
                setRegistering(true);
              }}
            >
              <span className="add-face" aria-hidden="true">
                <PlusIcon />
              </span>
            </button>
          )}
        </li>
      </ul>
      {data.agentsTruncated && (
        <p className="muted">
          Showing the first 100 agents. Use the owner agent API for additional
          profiles.
        </p>
      )}
    </section>
  );
}
