import { useEffect, useState } from 'react';
import { request } from '../shared/api.js';

/**
 * 撤回, pressed twice: the first press asks, and the question goes back
 * after a moment or when focus leaves.
 */
export function WithdrawButton({
  path,
  permitted,
  onSaved,
}: {
  path: string;
  permitted: boolean;
  /** With the message as withdrawn. */
  onSaved: (message: unknown) => void;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const back = setTimeout(() => {
      setAsking(false);
    }, 4000);
    return () => {
      clearTimeout(back);
    };
  }, [asking]);
  return (
    <button
      type="button"
      className={asking ? 'quiet subtle-danger' : 'quiet'}
      disabled={!permitted}
      onBlur={() => {
        setAsking(false);
      }}
      onClick={() => {
        if (!asking) {
          setAsking(true);
          return;
        }
        setAsking(false);
        void request(path + '/withdraw', {
          operationKey: crypto.randomUUID(),
        }).then(onSaved, () => undefined);
      }}
    >
      {asking ? '确认撤回' : '撤回'}
    </button>
  );
}
