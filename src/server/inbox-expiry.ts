import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import { describeFailure } from '../diagnostics.js';

/** Starts expiring work that never reached T3, the first time at once. */
export async function startInboxExpiry(app: FastifyInstance, store: Store) {
  // Work that never reached T3 expires on time, also for an agent no worker
  // serves: no claim ever looks at its work.
  const expire = () =>
    store.inbox.expire().catch((error: unknown) => {
      app.log.error(describeFailure(error), 'inbox_expiry_failed');
    });
  await expire();
  const expiring = setInterval(() => void expire(), 60_000);
  expiring.unref();
  app.addHook('onClose', () => {
    clearInterval(expiring);
    return Promise.resolve();
  });
}
