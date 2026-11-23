import { useState } from 'react';
import { Agent, ProfileInput } from '../../src/domain/agents.js';
import { request, value, useRequest } from '../shared/api.js';
import { ArrowIcon, PlusIcon } from '../shared/icons.js';
import { Avatar, Presence } from '../shared/faces.js';
import { composing } from '../shared/keys.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ActionForm } from '../shared/forms.js';
import { workerConnected } from '../shared/format.js';

/**
 * Register an agent in its own tile: a name and a role. Registered from a
 * channel, it joins that channel, and its page opens on the next step.
 */
export function RegisterAgent({
  teamId,
  channelPath,
  onClose,
  onRegistered,
}: {
  teamId: string;
  channelPath: string | null;
  onClose: () => void;
  onRegistered: (id: string) => void;
}) {
  const register = useRequest(
    { 409: '已有同名的智能体。' },
    '没有成功，再试一次。',
  );
  const [name, setName] = useState('');
  return (
    <form
      className="new-agent"
      aria-label="智能体资料"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void register
          .run(async () => {
            const agent = Agent.parse(
              await request(
                `/api/teams/${teamId}/agents`,
                ProfileInput.parse({
                  name: value(form, 'name').trim(),
                  role: value(form, 'role'),
                  capabilities: [],
                  preferences: {
                    environmentId: null,
                    providerId: null,
                    modelId: null,
                  },
                  memoryLocation: null,
                }),
              ),
            );
            // The agent exists now. If it can't join the channel, its page
            // still opens, saying it isn't in the channel beside the button
            // that adds it.
            if (channelPath)
              await request(channelPath + '/participants/invite', {
                operationKey: crypto.randomUUID(),
                member: { kind: 'agent', id: agent.id },
              }).catch(() => undefined);
            return agent.id;
          })
          .then((id) => {
            if (id !== undefined) onRegistered(id);
          });
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || composing(event)) return;
        event.preventDefault();
        onClose();
      }}
      // Leaving an empty tile puts the "+" back.
      onBlur={(event) => {
        if (
          name.trim() === '' &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          onClose();
      }}
    >
      {/* The tile is the agent to be: its face fills in as it is named. */}
      <span
        className="new-agent-face"
        data-named={name.trim() ? 'true' : undefined}
        aria-hidden="true"
      >
        {name.trim() ? (
          <Avatar kind="agent" name={name.trim()} size="xl" />
        ) : (
          <PlusIcon size={24} />
        )}
      </span>
      <span className="new-agent-name">
        <input
          name="name"
          aria-label="智能体名称"
          placeholder="名称"
          required
          maxLength={80}
          autoFocus
          autoComplete="off"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            register.setError('');
          }}
        />
        <button
          type="submit"
          className="icon-button confirm new-agent-go"
          aria-label="添加智能体"
          aria-busy={register.busy}
          disabled={register.disabled || name.trim() === ''}
        >
          <ArrowIcon />
        </button>
      </span>
      <select
        name="role"
        className="new-agent-role"
        aria-label="角色"
        defaultValue="developer"
      >
        <option value="developer">开发</option>
        <option value="reviewer">审核</option>
        <option value="assistant">助手</option>
      </select>
      {register.error && (
        <p className="new-agent-error" role="alert">
          {register.error}
        </p>
      )}
    </form>
  );
}
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
