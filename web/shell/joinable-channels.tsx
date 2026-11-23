import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { ActionForm } from '../shared/action-form.js';

/**
 * Channels you are not in but may join, muted under the rest: public ones
 * open to look in, and every one is one click from joining.
 */
export function JoinableChannels({
  teamId,
  channels,
  current,
  onOpen,
  onDone,
}: {
  teamId: string;
  channels: WorkspaceSnapshot['publicChannels'];
  /** The one open to look in. */
  current: string | null;
  onOpen: (id: string) => void;
  onDone: (id: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <ul className="left-channels" aria-label="可加入的频道">
      {channels.map((c) => (
        <li key={c.id}>
          {c.visibility === 'public' ? (
            <button
              type="button"
              aria-current={current === c.id ? 'page' : undefined}
              onClick={() => {
                onOpen(c.id);
              }}
            >
              <span aria-hidden="true">#</span> {c.name}
            </button>
          ) : (
            <span>
              <span aria-hidden="true">#</span> {c.name}
            </span>
          )}
          <ActionForm
            title={'加入 ' + c.name}
            path={`/api/teams/${teamId}/channels/${c.id}/subscribe`}
            build={() => ({})}
            submit="加入"
            onDone={() => {
              onDone(c.id);
            }}
          />
        </li>
      ))}
    </ul>
  );
}
