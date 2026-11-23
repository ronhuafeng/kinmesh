import type { Source } from './sources.js';

/**
 * Where a file sits. `src` goes up from the domain to the three processes,
 * which stand side by side; `web` goes up from `web/shared` through its
 * feature folders to the shell (`web/shell`, `web/app.tsx` and the entries)
 * that composes them; tests, scripts and deployment code use anything and
 * are used by nothing.
 */
type Layer =
  | { kind: 'src'; name: string; rank: number }
  | { kind: 'web'; name: 'shared' | 'shell' | `feature:${string}` }
  | { kind: 'consumer' };
const SRC_RANK: Record<string, number> = {
  domain: 0,
  adapters: 1,
  workspace: 2,
  persistence: 3,
  // What the processes share as they run: the worker's configuration and
  // the hub's protocol with it, and the files they keep on disk.
  runtime: 4,
  server: 5,
  inbox: 5,
  'team-mcp': 5,
};
/** The bundles the page loads first; they compose like the shell. */
const WEB_ENTRIES = new Set([
  'web/main.tsx',
  'web/boot.ts',
  'web/sw.ts',
  'web/hash-worker.ts',
]);
export function layerOf(path: string): Layer {
  const src = /^src\/([^/]+)\//.exec(path);
  if (src?.[1] !== undefined && src[1] in SRC_RANK)
    return { kind: 'src', name: src[1], rank: SRC_RANK[src[1]] ?? 0 };
  // Files at the root of `src` are shared by everything in it.
  if (/^src\/[^/]+$/.test(path))
    return { kind: 'src', name: 'domain', rank: 0 };
  if (path.startsWith('web/')) {
    const folder = /^web\/([^/]+)\//.exec(path)?.[1];
    if (folder === 'shared') return { kind: 'web', name: 'shared' };
    if (folder === undefined || folder === 'shell')
      return { kind: 'web', name: 'shell' };
    return { kind: 'web', name: `feature:${folder}` };
  }
  return { kind: 'consumer' };
}
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
const describe = (layer: Layer) =>
  layer.kind === 'consumer'
    ? 'tests, scripts or deploy'
    : layer.kind === 'src'
      ? 'src/' + layer.name
      : 'web ' + layer.name.replace('feature:', 'feature ');
/** Why `from` may not import `to`, or null when it may. */
export function refusal(from: string, to: string): string | null {
  const a = layerOf(from);
  const b = layerOf(to);
  if (a.kind === 'consumer') return null;
  if (b.kind === 'consumer')
    return 'nothing in src or web imports ' + describe(b);
  if (a.kind === 'src') {
    if (b.kind === 'web') return 'src never imports web';
    if (b.rank > a.rank) return `${describe(a)} sits below ${describe(b)}`;
    if (b.rank === a.rank && b.name !== a.name)
      return `${describe(a)} and ${describe(b)} stand side by side`;
    return null;
  }
  if (b.kind === 'src')
    return b.name === 'domain' || b.name === 'workspace'
      ? null
      : 'web reaches src only through its contracts (domain, workspace)';
  if (a.name === 'shell' || b.name === 'shared' || a.name === b.name)
    return null;
  return a.name === 'shared'
    ? `web shared imports ${describe(b)}`
    : `${describe(a)} imports ${describe(b)}`;
}
/** Imports that reach up or sideways. */
export function checkLayers(sources: Source[]): string[] {
  const errors: string[] = [];
  for (const source of sources)
    for (const target of source.imports) {
      const why = refusal(source.path, target);
      if (why !== null) errors.push(`${source.path} → ${target}: ${why}`);
    }
  return errors;
}
/** Imports that come back around (Tarjan's strongly connected components). */
export function checkCycles(sources: Source[]): string[] {
  const graph = new Map(sources.map((s) => [s.path, s.imports]));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let counter = 0;
  const connect = (node: string) => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (!index.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next))
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || (graph.get(node) ?? []).includes(node))
        cycles.push(component.sort());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) connect(node);
  return cycles.map((c) => 'import cycle: ' + c.join(' ↔ '));
}
