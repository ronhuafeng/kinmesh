import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { memberName } from './names.js';
import { workerConnected } from './format.js';
import {
  type DeliveryView,
  deliveryText,
  Words,
  unanswered,
  stoppable,
} from './deliveries.js';
import { Outcome } from './outcome.js';
import { Stop } from './stop.js';
import { Recovery } from './recovery.js';

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
      {unanswered(delivery) && delivery.step && (
        // What its run is on in T3: what waits on your approval there, or
        // the step it is taking.
        <span
          className="delivery-step"
          data-waiting={delivery.step.waiting ? 'true' : undefined}
        >
          {delivery.step.waiting ? '要执行 ' : ''}
          <code>{delivery.step.text}</code>
        </span>
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
