import { useAction } from './use-action.js';
import { Notice } from './notice.js';
import type { DeliveryView } from './deliveries.js';

/**
 * Stops the agent working on this: what hasn't reached T3 ends at once, a
 * run in T3 is interrupted and its stopped reply posted.
 */
export function Stop({
  delivery,
  teamId,
  onDone,
}: {
  delivery: DeliveryView;
  teamId: string;
  onDone: () => void;
}) {
  const action = useAction();
  const done = (ok: boolean) => {
    if (ok) onDone();
  };
  return (
    <>
      <button
        type="button"
        className="link-button"
        disabled={action.disabled || action.busy}
        onClick={() => {
          void (
            action.uncertain
              ? action.retry()
              : action.send(
                  `/api/teams/${teamId}/deliveries/${delivery.id}/stop`,
                  {},
                )
          ).then(done);
        }}
      >
        {action.uncertain ? '重试同一操作' : '停止'}
      </button>
      {action.error && <Notice>{action.error}</Notice>}
    </>
  );
}
