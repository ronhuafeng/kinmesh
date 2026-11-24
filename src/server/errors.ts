import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Refusal } from '../domain/errors.js';
import { DomainError } from '../domain/errors.js';
import { describeFailure } from '../diagnostics.js';

/** The HTTP status of each refusal; every route answers with these. */
const STATUS: Record<Refusal, 400 | 401 | 403 | 404 | 409 | 413> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'too-large': 413,
};
/**
 * How a failure answers: a refusal by its status, saying nothing of why; a
 * failure logged with what failed, and a refusal only when a constraint
 * caused it.
 */
export function registerErrors(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return void reply.code(400).send({ error: 'Invalid input' });
    // Fastify's own refusals (a body too large, a rate limit) carry theirs.
    const known = z
      .object({ statusCode: z.number().int().min(400).max(499) })
      .safeParse(error);
    const status =
      error instanceof DomainError
        ? STATUS[error.kind]
        : known.success
          ? known.data.statusCode
          : 500;
    // A failure is recorded; a refusal only when a constraint caused it.
    const where = {
      route: request.routeOptions.url,
      method: request.method,
      status,
    };
    if (status >= 500)
      request.log.error({ ...where, ...describeFailure(error) }, 'failed');
    else if (error instanceof Error && error.cause !== undefined)
      request.log.warn(
        { ...where, ...describeFailure(error.cause) },
        'refused',
      );
    void reply.code(status).send({
      error:
        status === 429
          ? 'Too many requests'
          : status < 500
            ? 'Request rejected'
            : 'Internal service error',
      ...(error instanceof DomainError && error.reason !== null
        ? { reason: error.reason }
        : {}),
    });
  });
}
