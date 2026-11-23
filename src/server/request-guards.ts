import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';

/**
 * What no request may carry: an actor claimed in a header or the query, or,
 * for a write, another site's origin.
 */
export function registerRequestGuards(app: FastifyInstance, config: Config) {
  app.addHook('onRequest', async (request, reply) => {
    if (
      ['x-actor-id', 'x-member-id', 'x-user-id', 'x-kinmesh-actor'].some(
        (header) => request.headers[header] !== undefined,
      )
    ) {
      return reply
        .code(400)
        .send({ error: 'Actor headers are not credentials' });
    }
    if (
      [...new URL(request.url, config.origin).searchParams.keys()].some((key) =>
        ['actor', 'actorid', 'agentid', 'humanid', 'role'].includes(
          key.toLowerCase(),
        ),
      )
    )
      return reply.code(400).send({ error: 'Actor query is not a credential' });
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      request.headers.origin !== undefined &&
      request.headers.origin !== config.origin
    ) {
      return reply.code(403).send({ error: 'Origin denied' });
    }
  });
}
