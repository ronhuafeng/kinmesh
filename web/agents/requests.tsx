import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ago, workerConnected } from '../shared/format.js';
import {
  deliveryText,
  stoppable,
  type DeliveryView,
} from '../shared/deliveries.js';
import { Outcome } from '../shared/outcome.js';
import { Recovery } from '../shared/recovery.js';
import { Stop } from '../shared/stop.js';
import { plainLine } from '../shared/task-draft.js';

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
