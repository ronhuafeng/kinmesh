import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../src/domain/agents.js';
import {
  decodeExecutionEvent,
  type ExecutionSnapshot,
} from '../../src/workspace/contracts.js';
import { useLive } from '../shared/live.js';
import { api, HttpError } from '../shared/api.js';
import { Notice } from '../shared/notice.js';
import { ago } from '../shared/format.js';
import { reported, NativeStatus } from './native-status.js';

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
