import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Avatar } from '../shared/avatar.js';
import { workerConnected } from '../shared/format.js';
import { deliveryText, unanswered } from '../shared/deliveries.js';
import { plainLine } from '../shared/task-draft.js';

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
