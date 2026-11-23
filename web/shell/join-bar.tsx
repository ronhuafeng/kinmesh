import { ActionForm } from '../shared/action-form.js';

/** Where a channel you only look in would take a message: joining it. */
export function JoinBar({
  teamId,
  channel,
  onDone,
}: {
  teamId: string;
  channel: { id: string; name: string };
  onDone: () => void;
}) {
  return (
    <div className="join-bar">
      <ActionForm
        title={'加入 ' + channel.name}
        path={`/api/teams/${teamId}/channels/${channel.id}/subscribe`}
        build={() => ({})}
        submit={'加入 #' + channel.name}
        onDone={onDone}
      />
    </div>
  );
}
