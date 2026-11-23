import { useState } from 'react';
import { ProfileInput, type Agent } from '../../src/domain/agents.js';
import { useRequest } from '../shared/use-request.js';
import { Notice } from '../shared/notice.js';
import { composing } from '../shared/keys.js';

/**
 * Everything else about the agent, every value in sight. The hand-run worker
 * is a task of its own, so it opens as its own page.
 */
/** What the agent is called and does, changed where it is shown. */
export function Identity({
  agent,
  teamId,
  onDone,
}: {
  agent: Agent;
  teamId: string;
  onDone: () => void;
}) {
  const action = useRequest({ 409: '已有同名的智能体。' });
  // Disabling takes a second press, which says what it does.
  const [asking, setAsking] = useState(false);
  const base = `/api/teams/${teamId}/agents/${agent.id}`;
  const save = (change: { name?: string; role?: Agent['role'] }) => {
    void action
      .send(
        base,
        ProfileInput.parse({
          name: agent.name,
          role: agent.role,
          capabilities: agent.capabilities,
          memoryLocation: agent.memoryLocation,
          preferences: agent.preferences,
          ...change,
        }),
        'PUT',
      )
      .then((done) => {
        if (done !== undefined) onDone();
      });
  };
  const active = agent.lifecycle === 'active';
  return (
    <>
      <dl>
        <dt>名称</dt>
        <dd>
          <input
            key={agent.name}
            className="about-field"
            aria-label="名称"
            defaultValue={agent.name}
            maxLength={80}
            disabled={action.disabled}
            onKeyDown={(event) => {
              if (composing(event)) return;
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.currentTarget.value = agent.name;
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              const name = event.currentTarget.value.trim();
              if (name === '' || name === agent.name) {
                event.currentTarget.value = agent.name;
                return;
              }
              save({ name });
            }}
          />
        </dd>
        <dt>角色</dt>
        <dd>
          <select
            className="about-field"
            aria-label="角色"
            value={agent.role}
            disabled={action.disabled}
            onChange={(event) => {
              const role = ProfileInput.shape.role.safeParse(
                event.currentTarget.value,
              );
              if (role.success) save({ role: role.data });
            }}
          >
            <option value="developer">开发</option>
            <option value="reviewer">审核</option>
            <option value="assistant">助手</option>
          </select>
        </dd>
      </dl>
      {action.error && <Notice>{action.error}</Notice>}
      <button
        type="button"
        className="link-button about-link"
        data-danger={active ? 'true' : undefined}
        disabled={action.disabled}
        onBlur={() => {
          setAsking(false);
        }}
        onClick={() => {
          if (active && !asking) {
            setAsking(true);
            return;
          }
          setAsking(false);
          void action
            .send(base + '/lifecycle', {
              lifecycle: active ? 'disabled' : 'active',
            })
            .then((done) => {
              if (done !== undefined) onDone();
            });
        }}
      >
        {active
          ? asking
            ? `确认停用：${agent.name} 不再接新的请求`
            : '停用智能体'
          : '重新启用智能体'}
      </button>
    </>
  );
}
