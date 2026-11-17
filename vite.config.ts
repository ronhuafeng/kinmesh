import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `web/boot.ts`, built as its own small entry, runs first on the page: a
 * script before the app's, so the workspace's stream opens while the app is
 * still on its way.
 */
const boot: Plugin = {
  name: 'kinmesh-boot',
  transformIndexHtml: {
    order: 'post',
    handler(_html, context) {
      const chunk = Object.values(context.bundle ?? {}).find(
        (output) =>
          output.type === 'chunk' && output.isEntry && output.name === 'boot',
      );
      if (!chunk) return [];
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: '/' + chunk.fileName },
          injectTo: 'head-prepend',
        },
      ];
    },
  },
};
/**
 * Each built script and stylesheet also as Brotli and gzip, compressed once
 * and as small as they go, for the hub to send to a browser that takes them.
 * Written after the bundle, so they hold exactly what the files do.
 */
const compressed: Plugin = {
  name: 'kinmesh-compressed',
  apply: 'build',
  writeBundle(options, bundle) {
    const directory = options.dir ?? '';
    for (const output of Object.values(bundle)) {
      if (!/\.(js|css|svg)$/.test(output.fileName)) continue;
      const source = Buffer.from(
        output.type === 'chunk' ? output.code : output.source,
      );
      if (source.length < 1024) continue;
      const file = join(directory, output.fileName);
      writeFileSync(
        file + '.br',
        brotliCompressSync(source, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
        }),
      );
      writeFileSync(file + '.gz', gzipSync(source, { level: 9 }));
    }
  },
};
export default defineConfig({
  root: 'web',
  plugins: [react(), boot, compressed],
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL('web/index.html', import.meta.url)),
        boot: fileURLToPath(new URL('web/boot.ts', import.meta.url)),
      },
    },
  },
});
