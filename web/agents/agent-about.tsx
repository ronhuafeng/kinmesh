import { useRef, useState } from 'react';
import { type Agent, ProfileInput } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { useRequest } from '../shared/api.js';
import { Notice } from '../shared/forms.js';
import { Avatar } from '../shared/faces.js';
import { composing } from '../shared/keys.js';
import { CopyButton } from '../shared/copy-button.js';
import { workerConnected } from '../shared/format.js';
import { type useT3, managedOf, t3Where } from '../shared/t3.js';
import { TeamMcp } from './team-mcp.js';

/** A square, small picture from any image the browser can read. */
async function avatarFrom(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas');
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    256,
    256,
  );
  bitmap.close();
  for (const quality of [0.86, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((done) => {
      canvas.toBlob(done, 'image/webp', quality);
    });
    if (blob?.type === 'image/webp' && blob.size <= 120 * 1024) return blob;
  }
  const png = await new Promise<Blob | null>((done) => {
    canvas.toBlob(done, 'image/png');
  });
  if (!png || png.size > 120 * 1024) throw new Error('Too large');
  return png;
}
/** The agent's face: click it to choose a picture. */
export function AvatarPicker({
  agent,
  data,
  onDone,
}: {
  agent: Agent;
  data: WorkspaceSnapshot;
  onDone: () => void;
}) {
  const picture = useRequest({}, '这张图片没有成功，换一张试试。');
  const file = useRef<HTMLInputElement>(null);
  const has = data.avatars.some((a) => a.agentId === agent.id);
  const path = `/api/teams/${data.team.id}/agents/${agent.id}/avatar`;
  const send = (body: Blob | undefined, method: 'PUT' | 'DELETE') =>
    picture.send(path, body, method).then((done) => {
      if (done !== undefined) onDone();
    });
  return (
    <div className="avatar-picker">
      <button
        type="button"
        className="avatar-change"
        aria-label={`更换 ${agent.name} 的头像`}
        title="更换头像"
        disabled={picture.disabled}
        onClick={() => file.current?.click()}
      >
        <Avatar kind="agent" name={agent.name} id={agent.id} size="xl" />
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!chosen) return;
          void avatarFrom(chosen).then(
            (blob) => send(blob, 'PUT'),
            () => {
              picture.setError('Kinmesh 无法使用这个文件作为图片。');
            },
          );
        }}
      />
      {has && (
        <button
          type="button"
          className="link-button subtle-danger"
          disabled={picture.disabled}
          onClick={() => {
            void send(undefined, 'DELETE');
          }}
        >
          移除头像
        </button>
      )}
      {picture.error && <Notice>{picture.error}</Notice>}
    </div>
  );
}
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
      <TeamMcp agent={agent} data={data} managed={managed !== null} />
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
