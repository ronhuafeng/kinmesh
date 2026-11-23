import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/** A failure answers with its status alone: nothing it was sent is echoed. */
export function registerErrors(app: FastifyInstance) {
  app.setErrorHandler((_error, _request, reply) => {
    // Never echo SDK validation inputs, tokens, database or request diagnostics.
    const status = z.object({ statusCode: z.number() }).safeParse(_error);
    void reply
      .code(
        status.success && [400, 413, 429].includes(status.data.statusCode)
          ? status.data.statusCode
          : 500,
      )
      .send({ error: 'Request rejected' });
  });
}
