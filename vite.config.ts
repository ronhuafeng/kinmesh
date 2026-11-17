import { fileURLToPath } from 'node:url';
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
export default defineConfig({
  root: 'web',
  plugins: [react(), boot],
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
