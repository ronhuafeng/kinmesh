import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';

/**
 * Every response says how browsers may treat it: no sniffing, no referrer,
 * and a content policy that reaches only the hub and the file store, and
 * sends forms only to the hub and GitHub.
 */
export function registerSecurityHeaders(app: FastifyInstance, config: Config) {
  // Browsers upload files straight to the store.
  const storeOrigin = new URL(config.files.publicEndpoint).origin;
  const connect =
    storeOrigin === new URL(config.origin).origin
      ? "'self'"
      : `'self' ${storeOrigin}`;
  // The one form that leaves: creating the team's app on GitHub's page.
  const forms = `'self' ${config.github.web}`;
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    // A response with a stricter policy of its own (a file) keeps it.
    if (!reply.hasHeader('Content-Security-Policy'))
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${connect}; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action ${forms}`,
      );
  });
}
