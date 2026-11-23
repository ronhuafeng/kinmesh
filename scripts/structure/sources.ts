import ts from 'typescript';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** A first-party source file, parsed, with the repository files it imports. */
export interface Source {
  path: string;
  ast: ts.SourceFile;
  imports: string[];
}
const SKIPPED = new Set([
  'node_modules',
  '.git',
  '.store',
  'dist',
  'web-dist',
  'coverage',
  'test-results',
  'playwright-report',
  'artifacts',
]);
const ROOTS = ['src', 'web', 'tests', 'scripts', 'deploy'];
/** The repository file an import names, if it names one. */
function resolveImport(
  from: string,
  specifier: string,
  exists: (path: string) => boolean,
) {
  if (!specifier.startsWith('.')) return null;
  const base = posix
    .normalize(posix.join(posix.dirname(from), specifier))
    .replace(/\.js$/, '');
  return [base + '.ts', base + '.tsx', base + '/index.ts'].find(exists) ?? null;
}
/** Every module a file imports, statically or dynamically, re-exports included. */
export function importsOf(ast: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return specifiers;
}
export function parse(path: string, text: string) {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}
/** Sources given as text by path, as fixtures give them. */
export function sourcesFrom(files: Record<string, string>): Source[] {
  const exists = (path: string) => path in files;
  return Object.entries(files).map(([path, text]) => {
    const ast = parse(path, text);
    return {
      path,
      ast,
      imports: importsOf(ast).flatMap(
        (specifier) => resolveImport(path, specifier, exists) ?? [],
      ),
    };
  });
}
/** The repository's TypeScript sources. */
export function readSources(root: string): Source[] {
  const files: Record<string, string> = {};
  const walk = (dir: string, relative: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
        files[path] = readFileSync(join(dir, entry.name), 'utf8');
    }
  };
  for (const top of ROOTS)
    if (existsSync(join(root, top))) walk(join(root, top), top);
  return sourcesFrom(files);
}
