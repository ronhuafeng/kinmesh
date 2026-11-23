import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { CopyButton } from '../shared/copy-button.js';
import { workerConnected } from '../shared/format.js';
import type { useT3 } from '../shared/use-t3.js';
import { managedOf, t3Where } from '../shared/t3.js';
import { AvatarPicker } from './avatar-picker.js';
import { Identity } from './identity.js';
import { TeamMcp } from './team-mcp.js';

export function AgentAbout({
  agent,
  data,
  t3,
  onOwnWorker,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  t3: ReturnType<typeof useT3>;
  onOwnWorker: () => void;
  onDone: () => void;
}) {
  const managed = managedOf(data, agent.id);
  const awake = workerConnected(data.wake, agent.id);
  const connection = t3.status?.connection ?? null;
  const where = connection && t3Where(connection);
  const provider = managed?.providerId ?? agent.preferences.providerId;
  return (
    <aside className="agent-about" aria-label="关于">
      <AvatarPicker agent={agent} data={data} onDone={onDone} />
      <Identity agent={agent} teamId={data.team.id} onDone={onDone} />
      <dl>
        <dt>提供方</dt>
        <dd>{provider ?? '未选择'}</dd>
        <dt>模型</dt>
        <dd>{agent.preferences.modelId ?? '未选择'}</dd>
        <dt>T3</dt>
        <dd>
          {where
            ? [where.host, where.access].filter(Boolean).join(' · ')
            : '未连接'}
        </dd>
        <dt>工作进程</dt>
        <dd>{managed ? '由 Kinmesh 运行' : awake ? '由你运行' : '未运行'}</dd>
      </dl>
      <TeamMcp agent={agent} data={data} />
      <dl>
        <dt>智能体 ID</dt>
        <dd className="agent-id">
          <code className="reference" title={agent.id}>
            {agent.id}
          </code>
          <CopyButton text={agent.id} label="复制" className="link-button" />
        </dd>
        <dt>记忆</dt>
        <dd>{agent.memoryLocation ?? '无'}</dd>
      </dl>
      <button
        type="button"
        className="link-button about-link"
        onClick={onOwnWorker}
      >
        自己运行工作进程 →
      </button>
    </aside>
  );
}
