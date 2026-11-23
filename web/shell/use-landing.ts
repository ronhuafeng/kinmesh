import { useEffect, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { attentionCount } from '../inbox/attention.js';
import type { Place } from './use-place.js';

/**
 * A phone opened with no place in its address starts where something waits
 * on you, if anything does; an address always wins.
 */
export function useLanding(
  data: WorkspaceSnapshot | null,
  phone: boolean,
  place: Place,
) {
  const { setFocus } = place;
  const [addressed] = useState(() => window.location.search !== '');
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !data) return;
    landed.current = true;
    if (phone && !addressed && attentionCount(data.attention) > 0)
      setFocus({ kind: 'inbox' });
  }, [data, phone, addressed, setFocus]);
}
