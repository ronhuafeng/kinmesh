import { useState } from 'react';
import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { api } from '../shared/api.js';
import { Notice } from '../shared/forms.js';
import { ago } from '../shared/format.js';
import { Providers, useSetupRequest } from '../shared/t3.js';
import { TEAM_MCP_SCOPES, Issued } from './setup-parts.js';
import { TokenOnce } from './setup-parts.js';
import { providerConfig } from './provider-config.js';

/**
 * Optional: let the agent read and act in Kinmesh while it works (Team MCP).
 * Without it the agent still answers; its reply comes back as a message.
 * For a provider Kinmesh knows, the credential comes as the configuration
 * to add to it, so nobody writes one by hand.
 */
export function TeamMcp({
  agent,
  data,
  providerId,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  /** The T3 provider the agent runs on, when chosen. */
  providerId: string | null;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [issued, setIssued] = useState<{
    token: string;
    driver: string | null;
  } | null>(null);
  const seen = data.teamMcp.find((p) => p.agentId === agent.id)?.lastSeenAt;
  const url = data.teamMcpUrl;
  // Without Team MCP served there is nowhere for a token to go.
  if (url === null) return null;
  /** What kind of provider the agent runs on; null when T3 doesn't say. */
  const driver = () =>
    providerId === null
      ? Promise.resolve(null)
      : api(`/api/teams/${data.team.id}/t3/providers`)
          .then(
            (raw) =>
              Providers.parse(raw).providers.find((p) => p.id === providerId)
                ?.driver ?? null,
          )
          .catch(() => null);
  const config =
    issued?.driver == null
      ? null
      : providerConfig(issued.driver, url, issued.token);
  return (
    <div className="about-mcp">
      <dl>
        <dt>Team MCP</dt>
        <dd>{seen ? `${ago(seen)}连接过` : '未设置'}</dd>
      </dl>
      {issued ? (
        <TokenOnce
          token={issued.token}
          config={config}
          agent={agent}
          where={
            config === null ? (
              <>
                把它粘贴到 T3 中 {agent.name} 的提供方，作为 <code>{url}</code>{' '}
                上 Team MCP 的 bearer token。
              </>
            ) : (
              <>
                把它加到 T3 中 {agent.name} 所用 Codex 的{' '}
                <code>config.toml</code>，Codex 重启后生效。
              </>
            )
          }
          onDismiss={() => {
            setIssued(null);
          }}
        />
      ) : (
        <button
          type="button"
          className="secondary"
          disabled={!permitted || busy || agent.lifecycle !== 'active'}
          onClick={() => {
            const kind = driver();
            void send(`/api/teams/${data.team.id}/agents/${agent.id}/grants`, {
              label: 'Team MCP',
              scopes: TEAM_MCP_SCOPES,
              lifetimeSeconds: 90 * 86400,
            }).then(async (raw) => {
              if (raw === undefined) return;
              setIssued({ token: Issued.parse(raw).token, driver: await kind });
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
