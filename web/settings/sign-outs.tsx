import { useContext } from 'react';
import { MutationPermission } from '../shared/api.js';
import { Group } from '../shared/group.js';

/** Signing out, here or everywhere: quiet rows in the danger colour. */
export function SignOuts({
  onSignOut,
  onSignOutEverywhere,
}: {
  onSignOut: () => void;
  /** Ends every session of yours, on every device, this one included. */
  onSignOutEverywhere: () => void;
}) {
  // Out of reach, signing out waits like every other action.
  const permitted = useContext(MutationPermission);
  return (
    <Group title="退出">
      <div className="you-row you-row-danger">
        <button type="button" disabled={!permitted} onClick={onSignOut}>
          退出登录
        </button>
      </div>
      <div className="you-row you-row-danger">
        <button
          type="button"
          disabled={!permitted}
          onClick={onSignOutEverywhere}
        >
          在所有设备上退出登录
        </button>
      </div>
    </Group>
  );
}
