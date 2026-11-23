import { useEffect, useRef, useState } from 'react';
import {
  decodeNativeObservation,
  type NativeObservation,
  type ExecutionSnapshot,
  decodeExecutionEvent,
  type WorkspaceSnapshot,
} from '../../src/workspace/contracts.js';
import { api, HttpError } from '../shared/api.js';
import type { Agent } from '../../src/domain/agents.js';
import { useLive } from '../shared/live.js';
import { Notice } from '../shared/forms.js';
import { ago, workerConnected } from '../shared/format.js';
import { Avatar } from '../shared/faces.js';
import {
  deliveryText,
  unanswered,
  stoppable,
  type DeliveryView,
  Outcome,
  Recovery,
  Stop,
} from '../shared/deliveries.js';
import { plainLine } from '../shared/task-draft.js';
import { Page } from '../shared/page.js';
import { AgentAbout } from './agent-about.js';
import { AgentSetup } from './agent-setup.js';
import { useT3 } from '../shared/t3.js';

export function NativeStatus({
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
        { signal: controller.signal },
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
        setError('现在无法查看 T3。等 T3 能连上时再试一次。');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      pending.current = null;
    }
  }
  const subject = correlation.reference.runId ? '这次运行' : '这个对话';
  return (
    <div className="native-status" role="cell">
      <span className="run-actions">
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
            在 T3 中查看
          </button>
        )}
        {observation?.verifiedUrl && (
          <a
            href={observation.verifiedUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            在 T3 中打开
          </a>
        )}
      </span>
      <div role="status" aria-live="polite">
        {busy && <p>正在查看 T3…</p>}
        {error && <p>{error}</p>}
        {observation &&
          (observation.status === 'unobserved' ? (
            <p>
              T3 于{' '}
              {new Date(observation.observedAt).toLocaleTimeString('zh-CN')}{' '}
              查看过，但这次运行早于它最近的记录，状态未知。
            </p>
          ) : (
            <>
              <p>
                {'T3 确认（' +
                  new Date(observation.observedAt).toLocaleTimeString('zh-CN') +
                  ' 查看）'}
              </p>
              <p>
                {subject}：{observation.status} ·{' '}
                {observation.terminal ? '已结束' : '仍在进行'}
              </p>
            </>
          ))}
        {observation && (
          <>
            <p title="按整个 T3 对话计数，不只是这次运行。">
              这个对话中未处理的请求：{observation.threadPendingRequests}
            </p>
            <p>
              模型：{observation.providerId ?? '未报告'} ·{' '}
              {observation.modelId ?? '未报告'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
/** What a person calls each recorded runtime state. */
export const reported: Record<string, string> = {
  unknown: '未知',
  active: '进行中',
  waiting: '等待中',
  succeeded: '已完成',
  failed: '失败',
  stopped: '已停止',
};
export function Activity({
  agent,
  teamId,
  trustedOrigin,
}: {
  agent: Agent;
  teamId: string;
  trustedOrigin: string | null;
}) {
  const { begin, settle, drop, reads } = useLive();
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const [error, setError] = useState('');
  const snapshotRequest = useRef<AbortController | null>(null);
  function loseAccess() {
    snapshotRequest.current?.abort();
    setSnapshot(null);
    setError('你已无权查看这些活动。请重新登录。');
  }
  useEffect(() => {
    const controller = new AbortController();
    snapshotRequest.current = controller;
    begin('runs');
    void api(`/api/agui/${teamId}/${agent.id}`, { signal: controller.signal })
      .then((raw) => {
        if (controller.signal.aborted) return;
        const next = decodeExecutionEvent(raw);
        setSnapshot(next);
        settle('runs', next.revision);
        setError('');
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        drop('runs');
        if (
          cause instanceof HttpError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          // Never retain a formerly authorized execution snapshot after access loss.
          setSnapshot(null);
          setError('你已无权查看这些活动。请重新登录。');
        } else {
          // A temporary transport/server outage does not certify a new snapshot.
          setError('现在无法加载活动，下次刷新时会再试。');
        }
      });
    return () => {
      controller.abort();
    };
  }, [agent.id, teamId, reads.runs, begin, settle, drop]);
  // Another agent's runs are another resource.
  useEffect(
    () => () => {
      drop('runs');
    },
    [agent.id, drop],
  );
  return (
    <section className="activity" aria-label={agent.name + ' 的活动'}>
      <h3>运行</h3>
      {error && <Notice>{error}</Notice>}
      {snapshot && (
        <>
          {snapshot.executions.length === 0 && (
            <p className="muted">还没有运行。</p>
          )}
          {snapshot.executions.length > 0 && (
            <div className="runs" role="table" aria-label="运行">
              <div className="run-head" role="row">
                <span role="columnheader">状态</span>
                <span role="columnheader">时间</span>
                <span role="columnheader">发起人</span>
                <span role="columnheader">T3 对话</span>
                <span role="columnheader">
                  <span className="visually-hidden">查看</span>
                </span>
              </div>
              {snapshot.executions.map((e) => {
                const latest = e.events.at(-1);
                const by = (kind: string) =>
                  kind === 'agent' ? agent.name : '成员';
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
                          title={new Date(latest.createdAt).toLocaleString(
                            'zh-CN',
                          )}
                        >
                          {ago(latest.createdAt)}
                        </time>
                      ) : (
                        '—'
                      )}
                    </span>
                    <span role="cell" className="run-by">
                      {latest ? by(latest.author.kind) : '—'}
                    </span>
                    {/* One reference per run: the thread, with the run and
                        environment on hover. */}
                    <code
                      role="cell"
                      className="run-ref"
                      title={[
                        ref.threadId,
                        ref.runId && ref.runId !== ref.threadId
                          ? '运行 ' + ref.runId
                          : null,
                        '环境 ' + ref.environmentId,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    >
                      {ref.threadId}
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
            <p className="muted">只显示最近 20 次运行。</p>
          )}
        </>
      )}
    </section>
  );
}
/**
 * The agent, and what it is doing now in one line: the request it is on
 * (and whether that waits on an approval), or that it is free or not
 * running.
 */
export function AgentHead({
  agent,
  data,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
}) {
  const connected = workerConnected(data.wake, agent.id);
  const open = data.deliveries.filter(
    (d) => d.agentId === agent.id && unanswered(d),
  );
  const current = open.at(-1);
  const state = current
    ? deliveryText(current, agent.name, connected)
    : connected
      ? { text: '空闲', tone: 'done' as const }
      : { text: '未运行', tone: 'problem' as const };
  const what =
    current &&
    (data.messages.items.find((m) => m.id === current.messageId)?.body ??
      data.tasks.items.find((t) => t.id === current.taskId)?.title);
  const line = what ? plainLine(what.trim().split('\n')[0] ?? '') : '';
  return (
    <header className="agent-head">
      <Avatar kind="agent" name={agent.name} id={agent.id} size="xl" />
      <span className="agent-head-text">
        <strong>{agent.name}</strong>
        <span className="agent-head-state" data-tone={state.tone}>
          {state.text.startsWith(agent.name)
            ? state.text.slice(agent.name.length).trimStart()
            : state.text}
          {line && (
            <span className="muted">
              {' · “'}
              {line.length > 60 ? line.slice(0, 57) + '…' : line}
              {'”'}
            </span>
          )}
          {open.length > 1 && (
            <span className="muted">{` · 还有 ${String(open.length - 1)} 个在等`}</span>
          )}
        </span>
      </span>
    </header>
  );
}
/** What was asked of the agent here, what came of it, and where the answer is. */
export function Requests({
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
    <section aria-label="请求">
      <h3>本频道的请求</h3>
      <ul className="requests">
        {requests.map((d) => {
          const { text, tone } = deliveryText(d, agent.name, connected);
          // On the agent's own page its name goes without saying.
          const outcome = text.startsWith(agent.name)
            ? text.slice(agent.name.length).trimStart()
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
                {what ? `“${what}”` : '一个请求'}
              </span>
              <Outcome
                delivery={d}
                teamId={data.team.id}
                t3Origin={data.nativeT3Origin}
                className="request-outcome"
              >
                {outcome}
              </Outcome>
              <span className="request-time">{when ? ago(when) : ''}</span>
              {onPage ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    onReply(reply);
                  }}
                >
                  查看回复
                </button>
              ) : stoppable(d) ? (
                <Stop delivery={d} teamId={data.team.id} onDone={onDone} />
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
      <AgentHead agent={agent} data={data} />
      {/* What it is doing and did comes first; how it is set up, last. */}
      <Requests agent={agent} data={data} onReply={onReply} onDone={onDone} />
      <Activity
        key={agent.id + (data.nativeT3Origin ?? '')}
        agent={agent}
        teamId={data.team.id}
        trustedOrigin={data.nativeT3Origin}
      />
      <section className="agent-settings" aria-label="设置">
        <h3>设置</h3>
        <div className="agent-layout">
          <div className="agent-main">
            <AgentSetup
              agent={agent}
              data={data}
              t3={t3}
              channelPath={channelPath}
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
      </section>
    </Page>
  );
}
