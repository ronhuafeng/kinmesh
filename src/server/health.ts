import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';

/**
 * Liveness: the process answers. Readiness: it can do its work. Both name
 * the commit the hub runs, so a deployment can be checked.
 */
export function registerHealth(
  app: FastifyInstance,
  store: Store,
  version: string | null,
  workerReady: () => boolean,
) {
  app.get('/health/live', (_request, reply) =>
    reply.send({ status: 'ok', component: 'kinmesh-team-hub', version }),
  );
  // Ready: the database answers (it opens only fully migrated) and the
  // supervised Inbox worker, when there is one, is connected.
  app.get('/health', async (_request, reply) => {
    const ready = (await store.ready()) && workerReady();
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'unavailable',
      component: 'kinmesh-team-hub',
      version,
    });
  });
}
