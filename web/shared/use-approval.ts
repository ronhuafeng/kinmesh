import { useEffect, useState } from 'react';
import { z } from 'zod';
import { trustedLinkOrigin } from '../../src/workspace/links.js';
import { api } from './api.js';
import type { DeliveryView } from './deliveries.js';

/**
 * Where T3 shows a run waiting for an approval, on the team's T3: null until
 * T3 has said, and whenever it can't be asked.
 */
export function useApproval(
  delivery: DeliveryView,
  teamId: string,
  t3Origin: string | null,
) {
  const [url, setUrl] = useState<string | null>(null);
  const waiting =
    delivery.state === 'waiting' &&
    delivery.reason === 'human-or-approval-wait';
  useEffect(() => {
    if (!waiting || t3Origin === null) return;
    const controller = new AbortController();
    api(`/api/teams/${teamId}/deliveries/${delivery.id}/link`, {
      signal: controller.signal,
    })
      .then((raw) => {
        const { url } = z.object({ url: z.url().nullable() }).parse(raw);
        if (controller.signal.aborted) return;
        setUrl(url !== null && trustedLinkOrigin(url, t3Origin) ? url : null);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [teamId, delivery.id, waiting, t3Origin]);
  return waiting ? url : null;
}
