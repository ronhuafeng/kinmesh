import type { Source } from './sources.js';

/** The bundles the page loads first; they compose like the shell. */
const WEB_ENTRIES = new Set([
  'web/main.tsx',
  'web/boot.ts',
  'web/sw.ts',
  'web/hash-worker.ts',
]);
/** The root of `web` holds the page's entries and the app; everything else has a folder. */
export function checkWebRoot(sources: Source[]): string[] {
  return sources
    .filter(
      (s) =>
        /^web\/[^/]+\.tsx?$/.test(s.path) &&
        !WEB_ENTRIES.has(s.path) &&
        s.path !== 'web/app.tsx' &&
        !s.path.endsWith('.d.ts'),
    )
    .map(
      (s) => `${s.path}: belongs in web/shared, a feature folder or web/shell`,
    );
}
