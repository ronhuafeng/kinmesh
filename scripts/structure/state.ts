import ts from 'typescript';
import type { Source } from './sources.js';

/** The app's composition root: it wires modules and holds no state of its own. */
const ROOTS = new Set(['web/app.tsx']);
const STATEFUL = new Set([
  'useState',
  'useReducer',
  'useEffect',
  'useLayoutEffect',
  'useRef',
  'useSyncExternalStore',
]);
export function checkState(sources: Source[]): string[] {
  const errors: string[] = [];
  for (const { path, ast } of sources) {
    if (!ROOTS.has(path)) continue;
    const used = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && STATEFUL.has(n.text)) used.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(ast);
    if (used.size > 0)
      errors.push(
        `${path}: holds state (${[...used].sort().join(', ')}); state belongs to the module that owns it`,
      );
  }
  return errors;
}
