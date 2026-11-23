import type { Source } from './sources.js';

/** What tests share: helpers, fixtures and the browser's own helpers. */
const SHARED =
  /(?:-helpers\.ts|\/helpers\.ts|\/fixtures?\/|\/fixture\.ts|^tests\/browser\/ui\.ts|^tests\/(?:raw|database|feishu|run)\.ts)$/;
/**
 * Tests stand apart: a test file imports shared helpers, never another
 * test; a browser spec is named after the part of the workspace it proves
 * (a feature folder of `web/`, or the shell).
 */
export function checkTests(sources: Source[]): string[] {
  const errors: string[] = [];
  const features = new Set(
    sources.flatMap((s) => /^web\/([^/]+)\//.exec(s.path)?.[1] ?? []),
  );
  features.add('shell');
  for (const { path, imports } of sources) {
    if (!/^tests\/.*\.(?:test|spec)\.ts$/.test(path)) continue;
    for (const target of imports)
      if (/\.(?:test|spec)\.ts$/.test(target) && !SHARED.test(target))
        errors.push(`${path} → ${target}: a test imports another test`);
    const spec = /^tests\/browser\/([^/]+)\.spec\.ts$/.exec(path)?.[1];
    if (spec !== undefined && !features.has(spec))
      errors.push(
        `${path}: a browser spec is named after a web feature folder or the shell`,
      );
  }
  return errors;
}
