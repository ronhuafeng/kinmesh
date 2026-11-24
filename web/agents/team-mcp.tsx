import { useState } from 'react';
import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { Notice } from '../shared/forms.js';
import { ago } from '../shared/format.js';
import { useSetupRequest } from '../shared/t3.js';
import { TEAM_MCP_SCOPES, Issued } from './setup-parts.js';
import { TokenOnce } from './setup-parts.js';
import { useCodexHome } from './codex-home.js';

/**
 * Optional: let the agent read and act in Kinmesh while it works (Team MCP).
 * Without it the agent still answers; its reply comes back as a message.
 * Where Kinmesh writes the agent's Codex home, there is nothing to issue.
 */
export function TeamMcp({
  agent,
  data,
  managed,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  /** Kinmesh runs the agent's worker, so it also writes its Codex home. */
  managed: boolean;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [token, setToken] = useState<string | null>(null);
  const codexHome = useCodexHome(data.team.id, agent.id);
  const seen = data.teamMcp.find((p) => p.agentId === agent.id)?.lastSeenAt;
  const url = data.teamMcpUrl;
  // Without Team MCP served there is nowhere for a token to go.
  if (url === null) return null;
  return (
    <div className="about-mcp">
      <dl>
        <dt>Team MCP</dt>
        <dd>{seen ? `${ago(seen)}连接过` : '未设置'}</dd>
      </dl>
      {managed && codexHome !== null ? null : token ? (
        <TokenOnce
          token={token}
          agent={agent}
          where={
            <>
              把它粘贴到 T3 中 {agent.name} 的提供方，作为 <code>{url}</code> 上
              Team MCP 的 bearer token。
            </>
          }
          onDismiss={() => {
            setToken(null);
          }}
        />
      ) : (
        <button
          type="button"
          className="secondary"
          disabled={!permitted || busy || agent.lifecycle !== 'active'}
          onClick={() => {
            void send(`/api/teams/${data.team.id}/agents/${agent.id}/grants`, {
              label: 'Team MCP',
              scopes: TEAM_MCP_SCOPES,
              lifetimeSeconds: 90 * 86400,
            }).then((raw) => {
              if (raw !== undefined) setToken(Issued.parse(raw).token);
            });
          }}
        >
          签发 Team MCP 凭据
        </button>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
