import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import type { Changes } from './changes.js';

/**
 * Closing: what the hub supervises stops first (`beforeClose`), then the
 * change feed and the store close.
 */
export function registerShutdown(
  app: FastifyInstance,
  store: Store,
  changes: Changes,
  beforeClose?: () => Promise<void>,
) {
  if (beforeClose) app.addHook('preClose', beforeClose);
  app.addHook('onClose', async () => {
    changes.close();
    await store.close();
  });
}
