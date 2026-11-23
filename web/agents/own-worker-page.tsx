import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Page } from '../shared/page.js';
import { managedOf } from '../shared/t3.js';
import { OwnWorker } from './own-worker.js';

/** Running the worker by hand is a task of its own, on a page of its own. */
export function OwnWorkerPage({
  agent,
  data,
  onClose,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  onClose: () => void;
  onDone: () => void;
}) {
  const managed = managedOf(data, agent.id);
  return (
    <Page label="自己运行工作进程" onClose={onClose}>
      <div className="page-body">
        <h2>自己运行 {agent.name} 的工作进程</h2>
        <OwnWorker
          agent={agent}
          data={data}
          managedGrantId={managed?.grantId ?? null}
          onDone={onDone}
        />
      </div>
    </Page>
  );
}
