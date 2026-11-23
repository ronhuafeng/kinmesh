import { useRef } from 'react';
import type { Agent } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { useRequest } from '../shared/use-request.js';
import { Notice } from '../shared/notice.js';
import { Avatar } from '../shared/avatar.js';

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
