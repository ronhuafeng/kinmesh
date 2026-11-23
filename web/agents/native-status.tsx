import { useEffect, useRef, useState } from 'react';
import {
  decodeNativeObservation,
  type NativeObservation,
  type ExecutionSnapshot,
} from '../../src/workspace/contracts.js';
import { api, HttpError } from '../shared/api.js';

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
