import type { Agent } from '../../src/domain/agents.js';
import {
  type useT3,
  useSetupRequest,
  managedOf,
  t3Where,
} from '../shared/t3.js';
import { type ReactNode, useEffect, useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ActionForm, Notice } from '../shared/forms.js';
import { workerConnected } from '../shared/format.js';
import { ConnectT3 } from './connect-t3.js';
import { ChooseModel } from './choose-model.js';

/**
 * The agent's setup shows one thing at a time: the next step, or, once the
 * agent can be woken, a single line saying so. Every other fact is in About.
 */
export function AgentSetup({
  agent,
  data,
  t3,
  channelPath,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  t3: ReturnType<typeof useT3>;
  channelPath: string | null;
  onDone: () => void;
}) {
  const { send, busy, error, permitted } = useSetupRequest();
  const [changing, setChanging] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const joined = data.joinedAgentIds.includes(agent.id);
  const awake = workerConnected(data.wake, agent.id);
  const managed = managedOf(data, agent.id);
  const connection = t3.status?.connection ?? null;
  const t3Ready =
    connection !== null && connection.access !== 'read' && !connection.expired;
  const connectedAt = connection?.connectedAt;
  useEffect(() => {
    setReconnecting(false);
  }, [connectedAt]);
  const base = `/api/teams/${data.team.id}/agents/${agent.id}`;
  let next: ReactNode = null;
  if (agent.lifecycle !== 'active')
    next = <p className="muted">{agent.name} 已停用，无法唤醒。</p>;
  else if (t3.status === null)
    next = (
      <p className="muted">
        {t3.failed ? '暂时读不到 T3 的状态，稍后会自动再试。' : '正在查看 T3…'}
      </p>
    );
  else if (t3.status.provisioned && connection === null)
    next = <p className="muted">正在连接 T3…</p>;
  else if (!t3Ready || reconnecting)
    next = (
      <ConnectT3
        teamId={data.team.id}
        t3={t3.status}
        reload={t3.load}
        agentName={agent.name}
      />
    );
  else if (!managed || changing)
    next = (
      <ChooseModel
        agent={agent}
        data={data}
        onDone={() => {
          setChanging(false);
          onDone();
        }}
        {...(managed
          ? {
              onCancel: () => {
                setChanging(false);
              },
            }
          : {})}
      />
    );
  const where = connection && t3Where(connection);
  const t3Line = where && (
    <span className="muted">
      T3 {where.host}
      {where.access && `（${where.access}）`}
    </span>
  );
  return (
    <section className="agent-setup" aria-label="配置">
      {next ? (
        <>
          {next}
          {t3Ready && !reconnecting && (
            <p className="setup-t3">
              {t3Line}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setReconnecting(true);
                }}
              >
                重新连接
              </button>
            </p>
          )}
        </>
      ) : (
        <div className="setup-status" data-ready={awake ? 'true' : undefined}>
          <span className="setup-mark" aria-hidden="true" />
          <p>
            <strong>{awake ? '可以回复了' : '正在启动工作进程…'}</strong>
          </p>
          <span className="setup-actions">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setChanging(true);
              }}
            >
              更换模型
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setReconnecting(true);
              }}
            >
              重新连接
            </button>
            <button
              type="button"
              className="link-button subtle-danger"
              disabled={!permitted || busy}
              onClick={() => {
                void send(base + '/disconnect').then((ok) => {
                  if (ok !== undefined) onDone();
                });
              }}
            >
              断开连接
            </button>
          </span>
        </div>
      )}
      {error && <Notice>{error}</Notice>}
      {/* Membership is per channel, not a setup step: say it, offer the fix. */}
      {!joined && channelPath && agent.lifecycle === 'active' && (
        <div className="channel-note">
          <p className="muted">
            {agent.name} 不在这个频道，这里的提及它收不到。
          </p>
          <ActionForm
            title={'邀请 ' + agent.name}
            path={channelPath + '/participants/invite'}
            build={() => ({ member: { kind: 'agent', id: agent.id } })}
            onDone={onDone}
            submit={'把 ' + agent.name + ' 加入频道'}
          />
        </div>
      )}
    </section>
  );
}
