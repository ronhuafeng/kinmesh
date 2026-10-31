import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { ago, wakeOf } from './ui.js';

export type DeliveryView = WorkspaceSnapshot['deliveries'][number];
type Tone = 'queued' | 'active' | 'waiting' | 'done' | 'problem';
/**
 * What a delivery means to the person who asked, in their words. The machine
 * state and reason stay available as a tooltip for whoever operates Kinmesh.
 */
export function deliveryText(
  d: DeliveryView,
  name: string,
  connected: boolean,
): { text: string; tone: Tone } {
  const since = d.queuedAt ? ` · ${ago(d.queuedAt)}` : '';
  switch (d.state) {
    case 'ready':
      if (!connected)
        return {
          text: `${name} isn’t connected, so nothing has picked this up yet`,
          tone: 'problem',
        };
      return d.reason === 'temporarily-unavailable'
        ? { text: `${name} will retry when T3 is reachable`, tone: 'waiting' }
        : { text: `${name} will pick this up${since}`, tone: 'queued' };
    case 'waiting':
      return d.reason === 'human-or-approval-wait' ||
        d.reason === 'approval-required'
        ? { text: `${name} is waiting for an approval in T3`, tone: 'waiting' }
        : { text: `${name} is working on it`, tone: 'active' };
    case 'uncertain':
      return {
        text: `Checking whether ${name}’s run started…`,
        tone: 'waiting',
      };
    case 'acked':
      return { text: `${name} replied`, tone: 'done' };
    case 'blocked':
      return {
        text: `${name} is stuck: T3 refused the request (permissions or setup)`,
        tone: 'problem',
      };
    case 'expired':
      return d.reason === 'undispatched-expiry'
        ? { text: `${name} never picked this up`, tone: 'problem' }
        : { text: `${name}’s request expired`, tone: 'problem' };
  }
}
export function DeliveryLine({
  delivery,
  data,
  onReply,
}: {
  delivery: DeliveryView;
  data: WorkspaceSnapshot;
  /** Jump to the agent's reply when it is on this page. */
  onReply?: (messageId: string) => void;
}) {
  const name =
    data.agents.find((a) => a.id === delivery.agentId)?.name ?? 'The agent';
  const { text, tone } = deliveryText(
    delivery,
    name,
    wakeOf(data.wake, delivery.agentId).connected,
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
          {text} ↓
        </button>
      ) : (
        <span>{text}</span>
      )}
      {delivery.state === 'blocked' && (
        <details className="delivery-recovery">
          <summary>How to recover</summary>
          <p>
            An operator fixes the agent’s T3 access or setup, then resumes this
            delivery with its original intent:
          </p>
          <code>npm run inbox:worker -- resume {delivery.id}</code>
        </details>
      )}
    </li>
  );
}
/** Latest delivery per agent, newest first, for one task. */
export function taskDeliveries(data: WorkspaceSnapshot, taskId: string) {
  const latest = new Map<string, DeliveryView>();
  for (const d of data.deliveries)
    if (d.taskId === taskId) latest.set(d.agentId, d);
  return [...latest.values()].reverse();
}
