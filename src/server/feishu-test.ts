import { humanOf } from './principals.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import { FeishuFailure, type Feishu } from './feishu.js';

/** A message from the team's Feishu bot, for a person to see it reaches them. */
export function registerFeishuTest(
  app: FastifyInstance,
  store: Store,
  origin: string,
  feishu: Feishu,
) {
  // The team's bot sends the person one message: 204 when Feishu took it,
  // 502 when it refused (no bot, no permission) or couldn't be reached.
  app.post('/api/feishu/test', async (request, reply) => {
    const humanId = humanOf(request);
    const union = await store.notifications.unionOf(humanId);
    if (union === null) return reply.code(409).send();
    const sent = await feishu
      .message(union, {
        title: 'Kinmesh',
        text: '飞书机器人能把通知送到你这里。',
        url: new URL('/?settings=connections', origin).href,
      })
      .then(
        () => true,
        (error: unknown) => {
          app.log.error(
            { error: error instanceof FeishuFailure ? error.message : 'Error' },
            'feishu_test_failed',
          );
          return false;
        },
      );
    return reply.code(sent ? 204 : 502).send();
  });
}
