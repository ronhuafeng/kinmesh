import { useEffect, useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import {
  BlockedReason,
  type BlockedReason as Cause,
  type DeliveryReason,
} from '../../src/domain/inbox.js';
import { ago, cjk } from './format.js';

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
 * A line's words. A new state cross-fades over the one it replaces instead
 * of jumping; while the agent works, a slow light passes over them (CSS).
 */
export function Words({ text }: { text: string }) {
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
/** Latest delivery per agent, newest first, for one task. */
export function taskDeliveries(data: WorkspaceSnapshot, taskId: string) {
  const latest = new Map<string, DeliveryView>();
  for (const d of data.deliveries)
    if (d.taskId === taskId) latest.set(d.agentId, d);
  return [...latest.values()].reverse();
}
