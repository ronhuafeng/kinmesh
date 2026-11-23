import type { FastifyReply } from 'fastify';
import { DomainError } from '../domain/errors.js';

/** A picture goes out as its detected type, never sniffed or run. */
export const picture = (
  reply: FastifyReply,
  image: { mime: string; bytes: Buffer } | null,
) => {
  if (image === null) throw new DomainError('not-found');
  return reply
    .header('content-type', image.mime)
    .header('cache-control', 'private, max-age=86400')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .send(image.bytes);
};
