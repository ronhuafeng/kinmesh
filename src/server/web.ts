import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export async function registerWeb(app: FastifyInstance) {
  const root = fileURLToPath(new URL('../../web-dist/', import.meta.url));
  // Only the immutable built public assets are served; no repository/cwd fallback.
  if (existsSync(join(root, 'assets'))) {
    await app.register(fastifyStatic, {
      root: join(root, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
      index: false,
      redirect: false,
      dotfiles: 'deny',
      maxAge: '1y',
      immutable: true,
    });
  }
  app.get('/', (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!existsSync(join(root, 'index.html')))
      return reply
        .code(503)
        .send('Workspace assets unavailable. Run npm run build.');
    return reply
      .type('text/html; charset=utf-8')
      .send(readFileSync(join(root, 'index.html')));
  });
}
