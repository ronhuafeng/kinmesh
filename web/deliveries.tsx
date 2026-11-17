import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { z } from 'zod';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { trustedLinkOrigin } from '../src/workspace/links.js';
import { BlockedReason } from '../src/domain/inbox.js';
import type {
  BlockedReason as Cause,
  DeliveryReason,
} from '../src/domain/inbox.js';
import { api, useAction } from './api.js';
import { Notice } from './forms.js';
import { memberName } from './names.js';
import { ago, cjk, workerConnected } from './ui.js';

export type DeliveryView = WorkspaceSnapshot['deliveries'][number];
type Tone = 'queued' | 'active' | 'waiting' | 'done' | 'problem';
/** How long an answer took, the way a person would say it. */
export function took(from: string, to: string) {
  const seconds = (Date.parse(to) - Date.parse(from)) / 1000;
  if (seconds < 60) return '不到 1 分钟';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours)} 小时` + (rest ? ` ${String(rest)} 分钟` : '');
}
/** A blocked delivery says what was lost, so the fix is obvious. */
function blockedText(reason: string, name: string) {
  const cause = BlockedReason.safeParse(reason);
  switch (cause.success ? cause.data : null) {
    case 'agent-disabled':
      return `${name} 已停用，这条请求暂停了`;
    case 'credential-invalid':
      return `${name} 的凭据已吊销、已过期或缺少权限`;
    case 'not-in-channel':
      return `${name} 已被移出频道，这条请求暂停了`;
    case 'not-assigned':
      return `任务已不再分配给 ${name}，所以停止了`;
    case 'native-access':
      return `T3 拒绝了 ${name} 的访问：请重新连接 T3`;
    case 'native-incompatible':
      return `${name} 的模型在 T3 中不可用：请换一个`;
    case 'native-unreadable':
      return `${name} 的结果无法显示：请更新 Kinmesh`;
    case 'authority-changed':
      return `${name} 的 T3 权限在运行中变了，回复发不出来：请重新提问`;
    case 'environment-changed':
      return `T3 已不是 ${name} 当初连接的环境：请重新连接 ${name}`;
    default:
      return `${name} 卡住了：请求被 Kinmesh 或 T3 拒绝`;
  }
}
/**
 * What a delivery means to the person who asked, in their words. The machine
 * state and reason stay available as a tooltip for whoever operates Kinmesh.
 */
export function deliveryText(
  d: DeliveryView,
  name: string,
  connected: boolean,
): { text: string; tone: Tone } {
  const line = sentence(d, name, connected);
  return { ...line, text: cjk(line.text) };
}
function sentence(
  d: DeliveryView,
  name: string,
  connected: boolean,
): { text: string; tone: Tone } {
  const since = d.queuedAt ? ` · ${ago(d.queuedAt)}` : '';
  // Reasons come from one vocabulary, so a misspelt one fails to compile.
  const because = (reason: DeliveryReason | Cause) => d.reason === reason;
  if (unanswered(d) && d.stopRequested)
    return { text: `${name} 正在停止`, tone: 'waiting' };
  switch (d.state) {
    case 'ready':
      if (!connected)
        return {
          text: `${name} 离线，还没人接手`,
          tone: 'problem',
        };
      if (because('sign-in-expired'))
        return {
          text: `T3 重新连接后 ${name} 会继续`,
          tone: 'waiting',
        };
      return because('temporarily-unavailable')
        ? { text: `T3 可用时 ${name} 会重试`, tone: 'waiting' }
        : { text: `${name} 会接手${since}`, tone: 'queued' };
    case 'waiting':
      return because('human-or-approval-wait')
        ? { text: `${name} 正在等待 T3 中的批准`, tone: 'waiting' }
        : { text: `${name} 正在处理`, tone: 'active' };
    case 'uncertain':
      return because('native-launch-pending')
        ? { text: `${name} 正在处理`, tone: 'active' }
        : { text: `正在确认 ${name} 是否已开始…`, tone: 'waiting' };
    case 'acked':
      return {
        text:
          `${name} 已回复` +
          (d.queuedAt && d.updatedAt
            ? '（用时 ' + took(d.queuedAt, d.updatedAt) + '）'
            : ''),
        tone: 'done',
      };
    case 'blocked':
      return { text: blockedText(d.reason, name), tone: 'problem' };
    case 'expired':
      if (because('stopped'))
        return { text: `${name} 开始前已停止`, tone: 'queued' };
      if (because('authority-changed'))
        return {
          text: `${name} 的 T3 权限变了，已停止`,
          tone: 'queued',
        };
      return because('undispatched-expiry')
        ? { text: `${name} 一直没有接手`, tone: 'problem' }
        : { text: `给 ${name} 的请求已过期`, tone: 'problem' };
  }
}
export const unanswered = (d: DeliveryView) =>
  d.state === 'ready' || d.state === 'waiting' || d.state === 'uncertain';
/**
 * Whether a person may stop it: not yet answered, and not already stopping;
 * or blocked because the T3 access its run started under is gone, which ends
 * it without T3.
 */
export const stoppable = (d: DeliveryView) =>
  (unanswered(d) && !d.stopRequested) ||
  (d.state === 'blocked' && d.reason === 'authority-changed');
/**
 * Stops the agent working on this: what hasn't reached T3 ends at once, a
 * run in T3 is interrupted and its stopped reply posted.
 */
export function Stop({
  delivery,
  teamId,
  onDone,
}: {
  delivery: DeliveryView;
  teamId: string;
  onDone: () => void;
}) {
  const action = useAction();
  const done = (ok: boolean) => {
    if (ok) onDone();
  };
  return (
    <>
      <button
        type="button"
        className="link-button"
        disabled={action.disabled || action.busy}
        onClick={() => {
          void (
            action.uncertain
              ? action.retry()
              : action.send(
                  `/api/teams/${teamId}/deliveries/${delivery.id}/stop`,
                  {},
                )
          ).then(done);
        }}
      >
        {action.uncertain ? '重试同一操作' : '停止'}
      </button>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
/**
 * Where T3 shows a run waiting for an approval, on the team's T3: null until
 * T3 has said, and whenever it can't be asked.
 */
function useApproval(
  delivery: DeliveryView,
  teamId: string,
  t3Origin: string | null,
) {
  const [url, setUrl] = useState<string | null>(null);
  const waiting =
    delivery.state === 'waiting' &&
    delivery.reason === 'human-or-approval-wait';
  useEffect(() => {
    if (!waiting || t3Origin === null) return;
    const controller = new AbortController();
    api(`/api/teams/${teamId}/deliveries/${delivery.id}/link`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    })
      .then((raw) => {
        const { url } = z.object({ url: z.url().nullable() }).parse(raw);
        if (controller.signal.aborted) return;
        setUrl(url !== null && trustedLinkOrigin(url, t3Origin) ? url : null);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [teamId, delivery.id, waiting, t3Origin]);
  return waiting ? url : null;
}
/**
 * What came of a request; while its run waits for an approval, a link to the
 * run in T3, where it is approved.
 */
export function Outcome({
  delivery,
  teamId,
  t3Origin,
  className,
  children,
}: {
  delivery: DeliveryView;
  teamId: string;
  t3Origin: string | null;
  className?: string;
  children: ReactNode;
}) {
  const approve = useApproval(delivery, teamId, t3Origin);
  return (
    <span className={className}>
      {approve ? (
        <a
          className="link-button"
          href={approve}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children} ↗
        </a>
      ) : (
        children
      )}
    </span>
  );
}
/**
 * A line's words. A new state cross-fades over the one it replaces instead
 * of jumping; while the agent works, a slow light passes over them (CSS).
 */
function Words({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const [was, setWas] = useState<string | null>(null);
  if (text !== shown) {
    setWas(shown);
    setShown(text);
  }
  useEffect(() => {
    if (was === null) return;
    const gone = setTimeout(() => {
      setWas(null);
    }, 200);
    return () => {
      clearTimeout(gone);
    };
  }, [was]);
  return (
    <span className="delivery-words">
      <span key={shown}>{shown}</span>
      {was !== null && (
        <span key={'was:' + was} className="was" aria-hidden="true">
          {was}
        </span>
      )}
    </span>
  );
}
export function DeliveryLine({
  delivery,
  data,
  channelId,
  onReply,
  openAgent,
  onDone,
}: {
  delivery: DeliveryView;
  data: WorkspaceSnapshot;
  channelId: string;
  /** Jump to the agent's reply when it is on this page. */
  onReply?: (messageId: string) => void;
  openAgent?: (agentId: string) => void;
  onDone: () => void;
}) {
  const { text, tone } = deliveryText(
    delivery,
    memberName({ kind: 'agent', id: delivery.agentId }, data),
    workerConnected(data.wake, delivery.agentId),
  );
  const reply = delivery.resultMessageId;
  const onPage =
    reply !== null && data.messages.items.some((m) => m.id === reply);
  return (
    <li
      className="delivery"
      data-tone={tone}
      title={`${delivery.state} · ${delivery.reason}`}
    >
      {onPage && onReply ? (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            onReply(reply);
          }}
        >
          <Words text={text} /> ↓
        </button>
      ) : (
        <Outcome
          delivery={delivery}
          teamId={data.team.id}
          t3Origin={data.nativeT3Origin}
        >
          <Words text={text} />
        </Outcome>
      )}
      {stoppable(delivery) && (
        <Stop delivery={delivery} teamId={data.team.id} onDone={onDone} />
      )}
      {delivery.state === 'blocked' && (
        <Recovery
          delivery={delivery}
          data={data}
          channelId={channelId}
          {...(openAgent ? { openAgent } : {})}
          onDone={onDone}
        />
      )}
    </li>
  );
}
/**
 * One way out of a blocked delivery: fix the cause in place and retry, or go
 * where it can be fixed. Retrying keeps the original intent; a cause that is
 * still there blocks it again with the same sentence.
 */
export function Recovery({
  delivery,
  data,
  channelId,
  openAgent,
  onDone,
}: {
  delivery: DeliveryView;
  data: WorkspaceSnapshot;
  channelId: string;
  openAgent?: (agentId: string) => void;
  onDone: () => void;
}) {
  const action = useAction();
  const team = `/api/teams/${data.team.id}`;
  const agentId = delivery.agentId;
  const name = memberName({ kind: 'agent', id: agentId }, data);
  const retry = () =>
    action.send(`${team}/deliveries/${delivery.id}/resume`, {}).then((ok) => {
      if (ok) onDone();
    });
  const fixThenRetry = (
    path: string,
    body: Record<string, unknown>,
    keyed: boolean,
  ) => {
    void action
      .send(path, body, keyed)
      .then((ok) => (ok ? retry() : undefined));
  };
  const cause = BlockedReason.safeParse(delivery.reason);
  const reason = cause.success ? cause.data : null;
  const busy = action.disabled || action.busy;
  return (
    <div className="delivery-recovery">
      {reason === 'agent-disabled' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            fixThenRetry(
              `${team}/agents/${agentId}/lifecycle`,
              { lifecycle: 'active' },
              false,
            );
          }}
        >
          重新启用 {name} 并重试
        </button>
      )}
      {reason === 'not-in-channel' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            fixThenRetry(
              `${team}/channels/${channelId}/participants/invite`,
              { member: { kind: 'agent', id: agentId } },
              true,
            );
          }}
        >
          把 {name} 加回频道并重试
        </button>
      )}
      {(reason === 'credential-invalid' ||
        reason === 'native-access' ||
        reason === 'native-incompatible' ||
        reason === 'environment-changed') &&
        openAgent && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              openAgent(agentId);
            }}
          >
            修复 {name} 的配置
          </button>
        )}
      {reason !== 'not-assigned' &&
        reason !== 'authority-changed' &&
        reason !== 'agent-disabled' &&
        reason !== 'not-in-channel' && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              void retry();
            }}
          >
            {action.busy ? '正在重试…' : '重试'}
          </button>
        )}
      {action.uncertain && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void action.retry().then((ok) => {
              if (ok) onDone();
            });
          }}
        >
          重试同一操作
        </button>
      )}
      {action.error && <Notice>{action.error}</Notice>}
      {reason === null && (
        <p className="muted recovery-operator">
          没有记下原因。请在运行工作进程的机器上用{' '}
          <code>npm run inbox:worker -- resume {delivery.id}</code> 恢复
        </p>
      )}
    </div>
  );
}
/** Latest delivery per agent, newest first, for one task. */
export function taskDeliveries(data: WorkspaceSnapshot, taskId: string) {
  const latest = new Map<string, DeliveryView>();
  for (const d of data.deliveries)
    if (d.taskId === taskId) latest.set(d.agentId, d);
  return [...latest.values()].reverse();
}
