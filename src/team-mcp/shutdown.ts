import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';

/** Closing Team MCP closes its store. */
export function registerShutdown(app: FastifyInstance, store: Store) {
  app.addHook('onClose', async () => {
    await store.close();
  });
}
