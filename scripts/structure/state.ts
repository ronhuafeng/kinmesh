import ts from 'typescript';
import type { Source } from './sources.js';

/**
 * A composition root assembles a process or the app: `main`, `app` or
 * `store` in `src` or `web`. It wires modules together and nothing more.
 */
export const isRoot = (path: string) =>
  /^(?:src|web)\/(?:.+\/)?(?:main|app|store)\.tsx?$/.test(path);
const REACT_STATE = new Set([
  'useState',
  'useReducer',
  'useEffect',
  'useLayoutEffect',
  'useRef',
  'useSyncExternalStore',
]);
const CONTAINERS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const TIMERS = new Set(['setInterval', 'setTimeout']);
const VERBS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'route',
  'all',
  'addHook',
]);
/**
 * What a composition root must not do itself: keep state (variables that
 * change, containers, timers, React state), reach data (queries), handle
 * requests (routes, hooks) or define behaviour (a function with statements
 * of its own beyond the one it exports, or control flow beyond choosing
 * between single statements).
 */
export function checkState(sources: Source[]): string[] {
  const errors: string[] = [];
  for (const { path, ast } of sources) {
    if (!isRoot(path)) continue;
    const found = new Set<string>();
    const exported = new Set<ts.Node>();
    for (const st of ast.statements)
      if (
        ts.canHaveModifiers(st) &&
        (ts.getModifiers(st) ?? []).some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        )
      )
        exported.add(st);
    const visit = (n: ts.Node, depth: number) => {
      if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.Let) !== 0)
        found.add('let');
      if (ts.isIdentifier(n) && REACT_STATE.has(n.text)) found.add(n.text);
      if (
        ts.isNewExpression(n) &&
        ts.isIdentifier(n.expression) &&
        CONTAINERS.has(n.expression.text)
      )
        found.add('new ' + n.expression.text);
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee) && TIMERS.has(callee.text))
          found.add(callee.text);
        if (ts.isIdentifier(callee) && callee.text === 'q')
          found.add('queries');
        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'app' &&
          VERBS.has(callee.name.text)
        )
          found.add('app.' + callee.name.text);
      }
      // Behaviour of its own: any function with a body of statements
      // beyond the exported one it composes in, and control flow.
      const composing = depth === 0 && exported.has(n);
      if (ts.isFunctionDeclaration(n) && !composing)
        found.add('function ' + (n.name?.text ?? ''));
      if (
        (ts.isArrowFunction(n) ||
          ts.isFunctionExpression(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isGetAccessor(n) ||
          ts.isSetAccessor(n)) &&
        n.body !== undefined &&
        ts.isBlock(n.body)
      )
        found.add('a function body');
      if (
        ts.isTryStatement(n) ||
        ts.isForStatement(n) ||
        ts.isForOfStatement(n) ||
        ts.isForInStatement(n) ||
        ts.isWhileStatement(n) ||
        ts.isDoStatement(n) ||
        ts.isSwitchStatement(n)
      )
        found.add('control flow');
      if (
        ts.isIfStatement(n) &&
        (ts.isBlock(n.thenStatement) ||
          (n.elseStatement !== undefined && ts.isBlock(n.elseStatement)))
      )
        found.add('control flow');
      ts.forEachChild(n, (c) => {
        visit(c, depth + 1);
      });
    };
    for (const st of ast.statements) visit(st, 0);
    if (found.size > 0)
      errors.push(
        `${path}: a composition root only wires modules together (${[...found].sort().join(', ')})`,
      );
  }
  return errors;
}
