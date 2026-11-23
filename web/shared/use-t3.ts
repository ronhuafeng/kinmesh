import { useCallback, useEffect, useState } from 'react';
import { useLive } from './live.js';
import { api } from './api.js';
import { T3Status } from './t3.js';

/**
 * The team's T3 connection, read again when the hub says it changed, such as
 * when a sign-in in T3 completes.
 */
export function useT3(teamId: string) {
  const [status, setStatus] = useState<T3Status | null>(null);
  // The last read failed: said, and read again after a growing pause.
  const [failing, setFailing] = useState(0);
  const { begin, settle, drop, reads } = useLive();
  const load = useCallback(() => {
    begin('t3');
    void api(`/api/teams/${teamId}/t3`)
      .then((raw) => {
        const next = T3Status.parse(raw);
        setStatus(next);
        setFailing(0);
        settle('t3', next.revision);
      })
      .catch(() => {
        setStatus(null);
        setFailing((old) => old + 1);
        drop('t3');
      });
  }, [teamId, begin, settle, drop]);
  useEffect(load, [load, reads.t3]);
  useEffect(() => {
    if (failing === 0) return;
    const again = setTimeout(load, Math.min(30_000, 2000 * 2 ** failing));
    return () => {
      clearTimeout(again);
    };
  }, [failing, load]);
  useEffect(
    () => () => {
      drop('t3');
    },
    [drop],
  );
  return { status, load, failed: failing > 0 };
}
