import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import { describeFailure } from '../diagnostics.js';
import { WORKER_GRANT } from './connect.js';

/** Starts renewing the hub's worker credentials, the first time before anything is served. */
export async function startGrantRenewal(app: FastifyInstance, store: Store) {
  // The hub's own worker credentials never run out while it serves their
  // agents: renewed now, before anything is served, then every hour.
  const renew = () =>
    store.managed
      .renewWorkerGrants(WORKER_GRANT.lifetimeSeconds)
      .catch((error: unknown) => {
        app.log.error(describeFailure(error), 'worker_grant_renewal_failed');
      });
  await renew();
  const renewing = setInterval(() => void renew(), 3_600_000);
  renewing.unref();
  app.addHook('onClose', () => {
    clearInterval(renewing);
    return Promise.resolve();
  });
}
