import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Page } from '../shared/page.js';
import { AgentAbout } from './agent-about.js';
import { AgentSetup } from './agent-setup.js';
import { useT3 } from '../shared/use-t3.js';
import { AgentHead } from './agent-head.js';
import { Requests } from './requests.js';
import { Activity } from './activity.js';

/** An agent's own page: who it is, whether it can be woken, what it did. */
export function AgentPage({
  agent,
  data,
  channelPath,
  onBack,
  onReply,
  onOwnWorker,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  channelPath: string | null;
  onBack: () => void;
  onReply: (messageId: string) => void;
  onOwnWorker: () => void;
  onDone: () => void;
}) {
  const t3 = useT3(data.team.id);
  return (
    <Page label={agent.name} onClose={onBack} className="agent-page">
      <AgentHead agent={agent} data={data} />
      {/* What it is doing and did comes first; how it is set up, last. */}
      <Requests agent={agent} data={data} onReply={onReply} onDone={onDone} />
      <Activity
        key={agent.id + (data.nativeT3Origin ?? '')}
        agent={agent}
        teamId={data.team.id}
        trustedOrigin={data.nativeT3Origin}
      />
      <section className="agent-settings" aria-label="设置">
        <h3>设置</h3>
        <div className="agent-layout">
          <div className="agent-main">
            <AgentSetup
              agent={agent}
              data={data}
              t3={t3}
              channelPath={channelPath}
              onDone={onDone}
            />
          </div>
          <AgentAbout
            agent={agent}
            data={data}
            t3={t3}
            onOwnWorker={onOwnWorker}
            onDone={onDone}
          />
        </div>
      </section>
    </Page>
  );
}
