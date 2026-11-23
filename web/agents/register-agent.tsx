import { useState } from 'react';
import { Agent, ProfileInput } from '../../src/domain/agents.js';
import { request, value } from '../shared/api.js';
import { useRequest } from '../shared/use-request.js';
import { ArrowIcon, PlusIcon } from '../shared/icons.js';
import { Avatar } from '../shared/avatar.js';
import { composing } from '../shared/keys.js';

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
