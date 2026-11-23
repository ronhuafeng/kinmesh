import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ListRow } from '../shared/list-row.js';
import { Avatar } from '../shared/avatar.js';
import { Presence } from '../shared/presence.js';
import { workerConnected } from '../shared/format.js';

export function Agents({
  data,
  openAgent,
}: {
  data: WorkspaceSnapshot;
  openAgent: (id: string) => void;
}) {
  return (
    <ul className="list-rows" aria-label="智能体">
      {data.agents.map((agent) => {
        const managed = data.managed.some((m) => m.agentId === agent.id);
        const awake = workerConnected(data.wake, agent.id);
        return (
          <ListRow
            key={agent.id}
            lead={
              <Avatar kind="agent" name={agent.name} id={agent.id} size="md" />
            }
            title={agent.name}
            detail={[
              agent.preferences.modelId,
              managed ? '由 Kinmesh 运行' : awake ? '由你运行' : '未运行',
            ]
              .filter(Boolean)
              .join(' · ')}
            end={<Presence online={awake} dot />}
            onOpen={() => {
              openAgent(agent.id);
            }}
          />
        );
      })}
    </ul>
  );
}
