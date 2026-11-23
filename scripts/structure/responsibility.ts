import ts from 'typescript';
import type { Source } from './sources.js';

const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
/** Names a file exports as declarations: functions and consts. */
function exportedValues(ast: ts.SourceFile) {
  const values: { name: string; node: ts.Node }[] = [];
  for (const statement of ast.statements) {
    if (!exported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name)
      values.push({ name: statement.name.text, node: statement });
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations)
        if (ts.isIdentifier(d.name))
          values.push({ name: d.name.text, node: d.initializer ?? d });
  }
  return values;
}
const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  // memo(function …), forwardRef(…)
  (ts.isCallExpression(node) && node.arguments.some((a) => isFunctionLike(a)));
/**
 * A UI file gives one thing to the rest of the app: one component or one
 * hook, with its own types and helpers. Shared parts are no exception:
 * each is its own file, so nothing becomes a drawer of parts.
 */
export function checkComponents(sources: Source[]): string[] {
  const errors: string[] = [];
  for (const { path, ast } of sources) {
    if (!path.startsWith('web/')) continue;
    const given = exportedValues(ast)
      .filter(
        ({ name, node }) =>
          isFunctionLike(node) &&
          (/^use[A-Z]/.test(name) ||
            (path.endsWith('.tsx') && /^[A-Z]/.test(name))),
      )
      .map(({ name }) => name);
    if (given.length > 1)
      errors.push(
        `${path}: gives ${String(given.length)} components or hooks (${given.join(', ')}); one per file`,
      );
  }
  return errors;
}
/** `s.table` passed to insert, update or delete. */
function writtenTable(call: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  if (!['insert', 'update', 'delete'].includes(call.expression.name.text))
    return null;
  const target = call.arguments[0];
  return target !== undefined && ts.isPropertyAccessExpression(target)
    ? target.name.text
    : null;
}
/**
 * The tables a function writes, itself or through functions of the same
 * module it calls. Effects through other modules (the outbox, the Inbox,
 * notifications, receipts) are theirs.
 */
function writer(local: Map<string, ts.Node>) {
  const known = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const tablesOf = (node: ts.Node): Set<string> => {
    const tables = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const table = writtenTable(n);
        if (table !== null) tables.add(table);
        if (ts.isIdentifier(n.expression)) {
          const name = n.expression.text;
          const body = local.get(name);
          if (body !== undefined && !visiting.has(name)) {
            if (!known.has(name)) {
              visiting.add(name);
              known.set(name, tablesOf(body));
              visiting.delete(name);
            }
            for (const t of known.get(name) ?? []) tables.add(t);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return tables;
  };
  return tablesOf;
}
/** Functions declared in a scope: `function f` and `const f = () =>`. */
function functionsIn(statements: readonly ts.Statement[]) {
  const found = new Map<string, ts.Node>();
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      found.set(statement.name.text, statement.body);
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations)
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          isFunctionLike(d.initializer)
        )
          found.set(d.name.text, d.initializer);
  }
  return found;
}
/** The object a repository factory returns: its methods by name. */
function methodsOf(factory: ts.FunctionDeclaration) {
  const methods = new Map<string, ts.Node>();
  for (const statement of factory.body?.statements ?? [])
    if (
      ts.isReturnStatement(statement) &&
      statement.expression !== undefined &&
      ts.isObjectLiteralExpression(statement.expression)
    )
      for (const p of statement.expression.properties) {
        if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name))
          methods.set(p.name.text, p);
        if (
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          isFunctionLike(p.initializer)
        )
          methods.set(p.name.text, p.initializer);
      }
  return methods;
}
/** Groups of methods joined by the tables they write (union-find). */
function writeGroups(writes: Map<string, Set<string>>) {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const owner = new Map<string, string>();
  for (const [method, tables] of writes)
    for (const table of tables) {
      const other = owner.get(table);
      if (other === undefined) owner.set(table, method);
      else parent.set(find(method), find(other));
    }
  const groups = new Map<string, { methods: string[]; tables: Set<string> }>();
  for (const [method, tables] of writes) {
    if (tables.size === 0) continue;
    const root = find(method);
    const group = groups.get(root) ?? { methods: [], tables: new Set() };
    group.methods.push(method);
    for (const t of tables) group.tables.add(t);
    groups.set(root, group);
  }
  return [...groups.values()];
}
/**
 * A persistence module is one repository: one factory, whose methods write
 * one connected set of tables. Methods that share no table they write are
 * separate repositories.
 */
export function checkRepositories(sources: Source[]): string[] {
  const errors: string[] = [];
  for (const { path, ast } of sources) {
    if (!path.startsWith('src/persistence/')) continue;
    const factories = ast.statements.filter(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && exported(s) && methodsOf(s).size > 0,
    );
    if (factories.length > 1)
      errors.push(
        `${path}: ${String(factories.length)} repositories (${factories.map((f) => f.name?.text).join(', ')}); one per file`,
      );
    for (const factory of factories) {
      const local = new Map([
        ...functionsIn(ast.statements),
        ...functionsIn(factory.body?.statements ?? []),
      ]);
      const tablesOf = writer(local);
      const writes = new Map(
        [...methodsOf(factory)].map(([name, node]) => [name, tablesOf(node)]),
      );
      const groups = writeGroups(writes);
      if (groups.length > 1)
        errors.push(
          `${path}: ${factory.name?.text ?? 'repository'} writes ${String(groups.length)} unrelated groups of tables: ` +
            groups
              .map(
                (g) =>
                  `[${[...g.tables].sort().join(', ')}] by ${g.methods.join(', ')}`,
              )
              .join('; '),
        );
    }
  }
  return errors;
}
/**
 * The text a path expression spells, with `*` for what can't be known
 * here: string literals, templates, `+` and local `const`s.
 */
function spelled(
  node: ts.Node,
  consts: Map<string, ts.Expression>,
  depth = 0,
): string {
  if (depth > 20) return '*';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans
        .map(
          (span) =>
            spelled(span.expression, consts, depth + 1) + span.literal.text,
        )
        .join('')
    );
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return (
      spelled(node.left, consts, depth + 1) +
      spelled(node.right, consts, depth + 1)
    );
  if (ts.isParenthesizedExpression(node))
    return spelled(node.expression, consts, depth + 1);
  if (ts.isIdentifier(node)) {
    const value = consts.get(node.text);
    return value === undefined ? '*' : spelled(value, consts, depth + 1);
  }
  return '*';
}
/** The resource a route belongs to: its first segment past `/api` and the team. */
export function resourceOf(path: string): string | null {
  const segment = path
    .replace(/^\/api(?=\/|$)/, '')
    .replace(/^\/teams\/:teamId(?=\/|$)/, '')
    .split('/')
    .find((s) => s !== '');
  return segment === undefined || segment.includes('*') ? null : segment;
}
const VERBS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'route',
  'all',
]);
/** A route module serves one resource: every path it registers starts the same. */
export function checkRoutes(sources: Source[]): string[] {
  const errors: string[] = [];
  for (const { path, ast } of sources) {
    if (!path.startsWith('src/server/')) continue;
    const consts = new Map<string, ts.Expression>();
    const resources = new Set<string>();
    const visit = (n: ts.Node) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer !== undefined &&
        ts.isVariableDeclarationList(n.parent) &&
        (n.parent.flags & ts.NodeFlags.Const) !== 0
      )
        consts.set(n.name.text, n.initializer);
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === 'app' &&
        VERBS.has(n.expression.name.text) &&
        n.arguments[0] !== undefined
      ) {
        const resource = resourceOf(spelled(n.arguments[0], consts));
        if (resource !== null) resources.add(resource);
      }
      ts.forEachChild(n, visit);
    };
    visit(ast);
    if (resources.size > 1)
      errors.push(
        `${path}: routes for ${String(resources.size)} resources (${[...resources].sort().join(', ')}); one per file`,
      );
  }
  return errors;
}
