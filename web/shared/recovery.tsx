import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { BlockedReason } from '../../src/domain/inbox.js';
import { useAction } from './use-action.js';
import { Notice } from './notice.js';
import { memberName } from './names.js';
import type { DeliveryView } from './deliveries.js';

/**
 * One way out of a blocked delivery: fix the cause in place and retry, or go
 * where it can be fixed. Retrying keeps the original intent; a cause that is
 * still there blocks it again with the same sentence.
 */
export function Recovery({
  delivery,
  data,
  channelId,
  openAgent,
  onDone,
}: {
  delivery: DeliveryView;
  data: WorkspaceSnapshot;
  channelId: string;
  openAgent?: (agentId: string) => void;
  onDone: () => void;
}) {
  const action = useAction();
  const team = `/api/teams/${data.team.id}`;
  const agentId = delivery.agentId;
  const name = memberName({ kind: 'agent', id: agentId }, data);
  const retry = () =>
    action.send(`${team}/deliveries/${delivery.id}/resume`, {}).then((ok) => {
      if (ok) onDone();
    });
  const fixThenRetry = (
    path: string,
    body: Record<string, unknown>,
    keyed: boolean,
  ) => {
    void action
      .send(path, body, keyed)
      .then((ok) => (ok ? retry() : undefined));
  };
  const cause = BlockedReason.safeParse(delivery.reason);
  const reason = cause.success ? cause.data : null;
  const busy = action.disabled || action.busy;
  return (
    <div className="delivery-recovery">
      {reason === 'agent-disabled' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            fixThenRetry(
              `${team}/agents/${agentId}/lifecycle`,
              { lifecycle: 'active' },
              false,
            );
          }}
        >
          重新启用 {name} 并重试
        </button>
      )}
      {reason === 'not-in-channel' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            fixThenRetry(
              `${team}/channels/${channelId}/participants/invite`,
              { member: { kind: 'agent', id: agentId } },
              true,
            );
          }}
        >
          把 {name} 加回频道并重试
        </button>
      )}
      {(reason === 'credential-invalid' ||
        reason === 'native-access' ||
        reason === 'native-incompatible' ||
        reason === 'environment-changed') &&
        openAgent && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              openAgent(agentId);
            }}
          >
            修复 {name} 的配置
          </button>
        )}
      {reason !== 'not-assigned' &&
        reason !== 'authority-changed' &&
        reason !== 'agent-disabled' &&
        reason !== 'not-in-channel' && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              void retry();
            }}
          >
            {action.busy ? '正在重试…' : '重试'}
          </button>
        )}
      {action.uncertain && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void action.retry().then((ok) => {
              if (ok) onDone();
            });
          }}
        >
          重试同一操作
        </button>
      )}
      {action.error && <Notice>{action.error}</Notice>}
      {reason === null && (
        <p className="muted recovery-operator">
          没有记下原因。请在运行工作进程的机器上用{' '}
          <code>npm run inbox:worker -- resume {delivery.id}</code> 恢复
        </p>
      )}
    </div>
  );
}
