import { useEffect } from 'react';
import { z } from 'zod';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { closeSettled, pushSupported, renew } from '../shared/push.js';

/** A notification clicked while the workspace is open (`sw.js`). */
const Opened = z.strictObject({
  kind: z.literal('open'),
  url: z.string().startsWith('/'),
});
/**
 * A browser where notifications are on for you stays on for this session;
 * a notification clicked opens its place here, and notifications about
 * what has since been read or settled close.
 */
export function usePush(data: WorkspaceSnapshot | null) {
  const signedIn = data !== null;
  useEffect(() => {
    if (!signedIn || !pushSupported()) return;
    void renew().catch(() => undefined);
    const onMessage = (event: MessageEvent) => {
      const message = Opened.safeParse(event.data);
      if (!message.success) return;
      window.history.pushState(null, '', message.data.url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, [signedIn]);
  useEffect(() => {
    if (data) void closeSettled(data).catch(() => undefined);
  }, [data]);
}
