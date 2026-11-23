import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import {
  PushPayload,
  PushSubscriptionInput,
  PushEndpoint,
} from '../domain/notify.js';
import type { Store } from '../persistence/store.js';
import { humanOf } from './principals.js';
import type { Notifier } from './notify.js';

const Id = z.strictObject({ id: z.string().regex(/^[\w-]{16}$/) });
/**
 * A person's browsers: notifications turned on, renewed and off, the ones
 * they are notified in, and a notification to see that one gets them.
 */
export function registerPush(
  app: FastifyInstance,
  store: Store,
  notifier: Notifier,
) {
  app.get('/api/push/key', (request) => {
    humanOf(request);
    return { publicKey: notifier.publicKey };
  });
  app.put('/api/push/subscription', async (request, reply) => {
    const humanId = humanOf(request);
    const session = request.session.get('session');
    if (typeof session !== 'string') throw new DomainError('unauthenticated');
    await store.browsers.subscribe(
      humanId,
      session,
      PushSubscriptionInput.parse(request.body),
    );
    return reply.code(204).send();
  });
  app.post('/api/push/renew', async (request, reply) => {
    const humanId = humanOf(request);
    const session = request.session.get('session');
    if (typeof session !== 'string') throw new DomainError('unauthenticated');
    await store.browsers.renew(
      humanId,
      session,
      PushEndpoint.parse(request.body).endpoint,
    );
    return reply.code(204).send();
  });
  app.post('/api/push/unsubscribe', async (request, reply) => {
    await store.browsers.unsubscribe(
      humanOf(request),
      PushEndpoint.parse(request.body).endpoint,
    );
    return reply.code(204).send();
  });
  // A person sends this browser a notification, to see that it gets them:
  // 410 when this browser no longer does, 502 when its push service
  // can't be reached.
  app.post('/api/push/test', async (request, reply) => {
    const humanId = humanOf(request);
    const { endpoint } = PushEndpoint.parse(request.body);
    const browser = await store.browsers.browser(humanId, endpoint);
    if (browser === null) return reply.code(410).send();
    const outcome = await notifier.push(
      browser,
      JSON.stringify(
        PushPayload.parse({
          title: 'Kinmesh',
          body: '这台设备能收到通知。',
          url: '/?settings',
          tag: 'test',
          kind: 'test',
          channelId: null,
          taskId: null,
          deliveryId: null,
        }),
      ),
    );
    return reply
      .code(outcome === 'sent' ? 204 : outcome === 'gone' ? 410 : 502)
      .send();
  });
  app.get('/api/push/browsers', (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return store.browsers.browserList(humanOf(request));
  });
  app.post('/api/push/forget', async (request, reply) => {
    const forgotten = await store.browsers.forgetBrowser(
      humanOf(request),
      Id.parse(request.body).id,
    );
    return reply.code(forgotten ? 204 : 404).send();
  });
}
