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
      // Built beside each file (`vite.config.ts`), and sent to a browser
      // that takes them.
      preCompressed: true,
    });
  }
  // The service worker, the web app manifest and its icons, at the site's
  // root where browsers look for them. The worker is always checked anew.
  const rootFiles: Record<string, string> = {
    'sw.js': 'text/javascript; charset=utf-8',
    'manifest.webmanifest': 'application/manifest+json',
    'icon-192.png': 'image/png',
    'icon-512.png': 'image/png',
    'apple-touch-icon.png': 'image/png',
  };
  for (const [name, type] of Object.entries(rootFiles))
    app.get('/' + name, (_request, reply) => {
      const path = join(root, name);
      if (!existsSync(path)) return reply.code(404).send();
      reply.header(
        'Cache-Control',
        name === 'sw.js' ? 'no-cache' : 'public, max-age=86400',
      );
      return reply.type(type).send(readFileSync(path));
    });
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
