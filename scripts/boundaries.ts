import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const privatePackage =
  /(?:@t3tools\/|t3code\/(?:apps|packages)\/|pingdotgg\/t3code)/i;
const privateResource =
  /(?:\.t3[/\\]|statev2\.sqlite|server-owner\.sqlite|\/api\/(?:ws|websocket)|t3code\/(?:apps|packages)\/)/i;
export function inspectSource(path: string, source: string): string[] {
  const errors: string[] = [];
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (/@ts-(?:ignore|nocheck|expect-error)\b/.test(source))
    errors.push(`${path}: unsafe type suppression`);
  function visit(node: ts.Node) {
    if (
      path.startsWith('src/') &&
      ts.isStringLiteral(node) &&
      privateResource.test(node.text)
    ) {
      errors.push(`${path}: private T3 resource literal`);
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (privatePackage.test(node.moduleSpecifier.text))
        errors.push(`${path}: private T3 import`);
      if (
        path.startsWith('src/domain/') &&
        /(?:persistence|server)/.test(node.moduleSpecifier.text)
      )
        errors.push(`${path}: domain depends on infrastructure`);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression.getText(ast);
      if (expression === 'WebSocket' || expression.endsWith('.WebSocket'))
        errors.push(`${path}: private or unreviewed WebSocket transport`);
      if (
        /(?:exec|spawn)/i.test(expression) &&
        /['"]t3['"]/.test(node.getText(ast)) &&
        /(?:update|uninstall|patch)/.test(node.getText(ast))
      )
        errors.push(`${path}: modifies external T3 installation`);
      for (const arg of node.arguments ?? []) {
        const text = arg.getText(ast);
        if (privatePackage.test(text) && /(?:import|require)/.test(expression))
          errors.push(`${path}: private T3 dynamic import`);
        if (
          privateResource.test(text) &&
          /(?:read|write|append|unlink|rm|rename|copy|chmod|open|Database|fetch|connect|resolve|join|URL)/i.test(
            expression,
          )
        )
          errors.push(`${path}: private T3 resource access`);
      }
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword)
      errors.push(`${path}: explicit any`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}
export function inspectManifest(path: string, source: string): string[] {
  // Inspect all string values and keys, including npm aliases and lockfile package entries.
  const value: unknown = JSON.parse(source);
  const errors: string[] = [];
  function visit(item: unknown): void {
    if (typeof item === 'string' && privatePackage.test(item))
      errors.push(`${path}: private T3 dependency`);
    else if (Array.isArray(item)) for (const entry of item) visit(entry);
    else if (typeof item === 'object' && item !== null)
      for (const [key, entry] of Object.entries(item)) {
        visit(key);
        visit(entry);
      }
  }
  visit(value);
  return errors;
}
export function checkRepository(root: string): string[] {
  const errors: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        ['node_modules', '.git', '.store', 'coverage', 'dist'].includes(
          entry.name,
        )
      )
        continue;
      const absolute = join(dir, entry.name);
      const path = relative(root, absolute).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (/(?:vendor|third.party).*t3|t3.*(?:vendor|third.party)/i.test(path))
          errors.push(`${path}: vendored T3 tree`);
        walk(absolute);
      } else if (entry.isFile()) {
        if (/\.(?:ts|tsx)$/.test(path))
          errors.push(...inspectSource(path, readFileSync(absolute, 'utf8')));
        if (/\.(?:js|mjs|cjs|jsx)$/.test(path))
          errors.push(`${path}: first-party JavaScript forbidden`);
        if (['package.json', 'package-lock.json'].includes(entry.name))
          errors.push(...inspectManifest(path, readFileSync(absolute, 'utf8')));
      }
    }
  }
  walk(root);
  return errors;
}
