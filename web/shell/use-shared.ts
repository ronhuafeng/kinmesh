import { useEffect, useState } from 'react';
import { sharedId, takeShared, type Shared } from '../shared/share.js';

/**
 * What the system shared to Kinmesh: asked where it goes, then handed to
 * that channel's composer.
 */
export function useShared() {
  const [shared, setShared] = useState<Shared | null>(null);
  const [incoming, setIncoming] = useState<
    { key: string; shared: Shared } | undefined
  >(undefined);
  useEffect(() => {
    if (sharedId === null) return;
    void takeShared(sharedId).then(
      (found) => {
        setShared(found);
      },
      () => undefined,
    );
  }, []);
  return { shared, setShared, incoming, setIncoming };
}
