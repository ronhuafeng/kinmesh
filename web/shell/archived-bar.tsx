import { ActionForm } from '../shared/action-form.js';

/**
 * In place of the composer in an archived channel: it is read, not written
 * to, until someone brings it back.
 */
export function ArchivedBar({
  teamId,
  channel,
  onDone,
}: {
  teamId: string;
  channel: { id: string; name: string };
  onDone: () => void;
}) {
  return (
    <div className="join-bar archived-bar">
      <p className="muted">#{channel.name} 已归档。</p>
      <ActionForm
        title={'恢复 ' + channel.name}
        path={`/api/teams/${teamId}/channels/${channel.id}/archive`}
        build={() => ({ archived: false })}
        submit="恢复频道"
        onDone={onDone}
      />
    </div>
  );
}
