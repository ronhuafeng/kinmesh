import { useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ActionForm } from '../shared/action-form.js';
import { PlusIcon } from '../shared/icons.js';
import { Avatar } from '../shared/avatar.js';
import { Presence } from '../shared/presence.js';
import { workerConnected } from '../shared/format.js';
import { RegisterAgent } from './register-agent.js';

export function Team({
  data,
  channelPath,
  channelName = '',
  onDone,
  openAgent,
  openPerson,
}: {
  data: WorkspaceSnapshot;
  channelPath: string | null;
  /** The open channel, which a tile's join names. */
  channelName?: string;
  onDone: () => void;
  openAgent: (id: string) => void;
  /** Opens your own conversation with someone. */
  openPerson: (id: string) => void;
}) {
  const [registering, setRegistering] = useState(false);
  // Two people's own conversation takes agents, never a third person.
  const direct = data.direct.some((d) => d.channelId === data.channel?.id);
  return (
    <section aria-label="团队">
      {/* Everyone as a tile, like a meeting's gallery: a face, a name, and
          whether they are here. A person's tile opens your own conversation
          with them, an agent's its page; the last tile adds an agent. */}
      <ul className="roster" aria-label="团队">
        <li className="roster-tile" data-kind="human">
          {/* You are one of the team; what is about you is at the foot of
              the sidebar. */}
          <span className="roster-person">
            <Avatar
              kind="human"
              name={data.human.name}
              id={data.human.id}
              size="xl"
            />
            <span className="roster-name">{data.human.name}</span>
            {/* You are the one looking. */}
            <Presence online />
          </span>
        </li>
        {data.people
          .filter((person) => person.id !== data.human.id)
          .map((person) => (
            <li key={person.id} className="roster-tile" data-kind="human">
              {/* Their face opens your own conversation with them. */}
              <button
                type="button"
                className="roster-person"
                onClick={() => {
                  openPerson(person.id);
                }}
              >
                <Avatar
                  kind="human"
                  name={person.name}
                  id={person.id}
                  size="xl"
                />
                <span className="roster-name">{person.name}</span>
                <Presence online={person.online} />
              </button>
              {/* Like an agent: only a missing membership needs a fix. */}
              {channelPath &&
                !direct &&
                !data.joinedHumanIds.includes(person.id) && (
                  <ActionForm
                    title={'邀请 ' + person.name}
                    path={channelPath + '/participants/invite'}
                    build={() => ({ member: { kind: 'human', id: person.id } })}
                    onDone={onDone}
                    submit={'加入 #' + channelName}
                    submitName={'把 ' + person.name + ' 加入 #' + channelName}
                  />
                )}
            </li>
          ))}
        {data.agents.map((agent) => {
          const awake = workerConnected(data.wake, agent.id);
          return (
            <li
              key={agent.id}
              className="roster-tile"
              data-kind="agent"
              data-lifecycle={agent.lifecycle}
            >
              <button
                type="button"
                className="roster-person"
                onClick={() => {
                  openAgent(agent.id);
                }}
              >
                <Avatar
                  kind="agent"
                  name={agent.name}
                  id={agent.id}
                  size="xl"
                />
                <span className="roster-name">{agent.name}</span>
                {/* Online: a worker is connected, so a mention wakes it. */}
                <Presence online={awake} />
              </button>
              {/* Membership is in the sidebar; only a missing one needs a fix. */}
              {channelPath &&
                agent.lifecycle === 'active' &&
                !data.joinedAgentIds.includes(agent.id) && (
                  <ActionForm
                    title={'邀请 ' + agent.name}
                    path={channelPath + '/participants/invite'}
                    build={() => ({ member: { kind: 'agent', id: agent.id } })}
                    onDone={onDone}
                    submit={'加入 #' + channelName}
                    submitName={'把 ' + agent.name + ' 加入 #' + channelName}
                  />
                )}
            </li>
          );
        })}
        <li className="roster-tile roster-add">
          {registering ? (
            <RegisterAgent
              teamId={data.team.id}
              channelPath={channelPath}
              onClose={() => {
                setRegistering(false);
              }}
              onRegistered={(id) => {
                setRegistering(false);
                onDone();
                openAgent(id);
              }}
            />
          ) : (
            <button
              type="button"
              className="roster-person"
              aria-label="添加智能体"
              onClick={() => {
                setRegistering(true);
              }}
            >
              <span className="add-face" aria-hidden="true">
                <PlusIcon size={24} />
              </span>
            </button>
          )}
        </li>
      </ul>
      {data.agentsTruncated && (
        <p className="muted">
          只显示前 100 个智能体，其余的请通过智能体 API 查看。
        </p>
      )}
    </section>
  );
}
