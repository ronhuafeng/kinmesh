import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { BlockedReason } from '../src/domain/inbox.js';
import type { DeliveryReason } from '../src/domain/inbox.js';
import { useAction } from './api.js';
import { Notice } from './forms.js';
import { memberName } from './names.js';
import { ago, workerConnected } from './ui.js';

export type DeliveryView = WorkspaceSnapshot['deliveries'][number];
type Tone = 'queued' | 'active' | 'waiting' | 'done' | 'problem';
/** How long an answer took, the way a person would say it. */
export function took(from: string, to: string) {
  const seconds = (Date.parse(to) - Date.parse(from)) / 1000;
  if (seconds < 60) return 'in under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `after ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `after ${String(hours)} h` + (rest ? ` ${String(rest)} min` : '');
}
/** A blocked delivery says what was lost, so the fix is obvious. */
function blockedText(reason: string, name: string) {
  const cause = BlockedReason.safeParse(reason);
  switch (cause.success ? cause.data : null) {
    case 'agent-disabled':
      return `${name} is disabled, so this is on hold`;
    case 'credential-invalid':
      return `${name}’s credential was revoked, expired or lacks a permission`;
    case 'not-in-channel':
      return `${name} was removed from the channel, so this is on hold`;
    case 'not-assigned':
      return `The task is no longer assigned to ${name}, so this was stopped`;
    case 'native-access':
      return `T3 refused ${name}’s access: reconnect T3 and choose Supervised`;
    case 'native-incompatible':
      return `${name}’s model isn’t available in T3: choose another one`;
    case 'environment-changed':
      return `T3 is no longer the environment ${name} was connected to: connect ${name} again`;
    default:
      return `${name} is stuck: Kinmesh or T3 refused the request`;
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
  const since = d.queuedAt ? ` · ${ago(d.queuedAt)}` : '';
  // Reasons come from one vocabulary, so a misspelt one fails to compile.
  const because = (reason: DeliveryReason) => d.reason === reason;
  switch (d.state) {
    case 'ready':
      if (!connected)
        return {
          text: `${name} isn’t connected, so nothing has picked this up yet`,
          tone: 'problem',
        };
      return because('temporarily-unavailable')
        ? { text: `${name} will retry when T3 is reachable`, tone: 'waiting' }
        : { text: `${name} will pick this up${since}`, tone: 'queued' };
    case 'waiting':
      return because('human-or-approval-wait')
        ? { text: `${name} is waiting for an approval in T3`, tone: 'waiting' }
        : { text: `${name} is working on it`, tone: 'active' };
    case 'uncertain':
      return {
        text: `Checking whether ${name}’s run started…`,
        tone: 'waiting',
      };
    case 'acked':
      return {
        text:
          `${name} replied` +
          (d.queuedAt && d.updatedAt
            ? ' ' + took(d.queuedAt, d.updatedAt)
            : ''),
        tone: 'done',
      };
    case 'blocked':
      return { text: blockedText(d.reason, name), tone: 'problem' };
    case 'expired':
      return because('undispatched-expiry')
        ? { text: `${name} never picked this up`, tone: 'problem' }
        : { text: `${name}’s request expired`, tone: 'problem' };
  }
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
          {text} ↓
        </button>
      ) : (
        <span>{text}</span>
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
          Re-enable {name} and retry
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
          Add {name} back and retry
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
            Fix {name}’s setup
          </button>
        )}
      {reason !== 'not-assigned' &&
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
            {action.busy ? 'Retrying…' : 'Retry'}
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
          Retry the same action
        </button>
      )}
      {action.error && <Notice>{action.error}</Notice>}
      {reason === null && (
        <p className="muted recovery-operator">
          The cause wasn’t recorded. On the worker machine, resume it with{' '}
          <code>npm run inbox:worker -- resume {delivery.id}</code>
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
