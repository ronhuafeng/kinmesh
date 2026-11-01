import type { ReactNode } from 'react';
import type { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { deliveryText } from './deliveries.js';
import { humanAsk } from './tasks.js';
import { Drawer, ago, plural, wakeOf } from './ui.js';

export type Attention = WorkspaceSnapshot['attention'];
export function attentionCount(attention: Attention) {
  return (
    attention.decide.length +
    attention.unstuck.length +
    attention.connect.length
  );
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="needs-group" aria-label={title}>
      <h3>{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}
/**
 * Everything waiting on this person across the team, grouped by what they have
 * to do. Items leave as soon as their cause is resolved; nothing to dismiss.
 */
export function NeedsDrawer({
  data,
  onClose,
  openTask,
  openChannel,
  openAgent,
}: {
  data: WorkspaceSnapshot;
  onClose: () => void;
  openTask: (channelId: string, taskId: string) => void;
  openChannel: (channelId: string) => void;
  openAgent: (agentId: string) => void;
}) {
  const { decide, unstuck, connect } = data.attention;
  const name = (id: string) =>
    data.agents.find((a) => a.id === id)?.name ?? 'An agent';
  return (
    <Drawer label="Needs you" onClose={onClose} className="needs-drawer">
      <div className="drawer-body">
        <h2>Needs you</h2>
        {attentionCount(data.attention) === 0 && (
          <p className="muted">Nothing needs you.</p>
        )}
        {decide.length > 0 && (
          <Group title="Decide">
            {decide.map(({ task, channelName }) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="needs-item"
                  onClick={() => {
                    openTask(task.channelId, task.id);
                  }}
                >
                  <span className="needs-what">
                    {humanAsk(task, data) ?? 'Your decision'}:{' '}
                    <strong>{task.title}</strong>
                  </span>
                  <small>
                    #{channelName} · {ago(task.updatedAt)}
                  </small>
                </button>
              </li>
            ))}
          </Group>
        )}
        {unstuck.length > 0 && (
          <Group title="Unstuck">
            {unstuck.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="needs-item"
                  data-tone="problem"
                  onClick={() => {
                    if (d.taskId) openTask(d.channelId, d.taskId);
                    else openChannel(d.channelId);
                  }}
                >
                  <span className="needs-what">
                    {
                      deliveryText(
                        d,
                        name(d.agentId),
                        wakeOf(data.wake, d.agentId).connected,
                      ).text
                    }
                  </span>
                  <small>
                    #{d.channelName}
                    {d.updatedAt ? ' · ' + ago(d.updatedAt) : ''}
                  </small>
                </button>
              </li>
            ))}
          </Group>
        )}
        {connect.length > 0 && (
          <Group title="Connect">
            {connect.map((c) => (
              <li key={c.agentId}>
                <button
                  type="button"
                  className="needs-item"
                  onClick={() => {
                    openAgent(c.agentId);
                  }}
                >
                  <span className="needs-what">
                    {name(c.agentId)} has {plural(c.queued, 'request')} waiting
                    but can’t be woken yet
                  </span>
                  <small>Finish setup</small>
                </button>
              </li>
            ))}
          </Group>
        )}
      </div>
    </Drawer>
  );
}
