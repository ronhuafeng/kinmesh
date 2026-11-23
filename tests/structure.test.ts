import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSources } from '../scripts/structure/index.js';
import { resourceOf } from '../scripts/structure/responsibility.js';
import { sourcesFrom } from '../scripts/structure/sources.js';

// `npm run architecture` (CI) checks the repository: layers and cycles with
// dependency-cruiser, the rest with these rules, which these prove refuse
// what they should and let the rest through.
const check = (files: Record<string, string>) =>
  checkSources(sourcesFrom(files));

await test('the root of web holds the entries and the app; the rest has a folder', () => {
  assert.deepEqual(
    check({
      'web/main.tsx': 'export {};',
      'web/app.tsx': 'export function App() { return null; }',
      'web/shared/a.ts': 'export const a = 1;',
    }),
    [],
  );
  assert.match(
    check({ 'web/helpers.ts': 'export const h = 1;' }).join(),
    /belongs in web\/shared/,
  );
});

await test('a composition root only wires modules together', () => {
  // Composing: calls, single-expression callbacks, and a choice between
  // single statements.
  assert.deepEqual(
    check({
      'src/server/app.ts':
        "import { a } from './a.js'; export async function createApp(c) { const app = await a(c, () => c.ready); if (!app) return null; register(app); return app; }",
      'src/server/a.ts': 'export const a = 1;',
    }),
    [],
  );
  const refused = (source: string) => {
    assert.match(
      check({ 'src/server/app.ts': source }).join(),
      /only wires modules together/,
      source,
    );
  };
  // A process's entry keeps its lifecycle: it is not a composition root.
  assert.deepEqual(
    check({ 'src/inbox/main.ts': 'let stopping = false; void stopping;' }),
    [],
  );
  // State, data, requests and behaviour of its own, each refused.
  refused('let started = false; void started;');
  refused('export const seen = new Set();');
  refused('setInterval(() => undefined, 1000);');
  refused(
    "import { useState } from 'react'; export function App() { return useState(0); }",
  );
  refused('export function open() { return q().select(); }');
  refused("export function wire(app) { app.get('/x', h); }");
  refused("export function wire(app) { app.addHook('onClose', h); }");
  refused('function helper() { return 1; } export const x = helper();');
  refused('export const run = () => { return 1; };');
  refused('try { start(); } catch { stop(); }');
  refused('for (const s of signals) listen(s);');
  refused('if (ready) { start(); }');
});

await test('a repository writes one connected set of tables; routes serve one resource', () => {
  const repository = (body: string) => ({
    'src/persistence/r.ts': `export function repo() { function touch() { return q().insert(s.c); } return { ${body} }; }`,
  });
  assert.deepEqual(
    check(
      repository(
        'a() { q().insert(s.a); q().update(s.b); }, b() { q().delete(s.b); touch(); }, read() { return 1; }',
      ),
    ),
    [],
  );
  assert.match(
    check(repository('a() { q().insert(s.a); }, b() { touch(); }')).join(),
    /2 unrelated groups/,
  );
  assert.equal(
    resourceOf('/api/teams/:teamId/channels/:channelId/pin'),
    'channels',
  );
  assert.equal(resourceOf('/api/workspace'), 'workspace');
  const routes = (paths: string[]) => ({
    'src/server/r.ts':
      "const base = '/api/teams/:teamId/channels'; export function registerR(app) { " +
      paths.map((p) => `app.post(${p}, h);`).join(' ') +
      ' }',
  });
  assert.deepEqual(check(routes(["base + '/:id/pin'", 'base'])), []);
  assert.match(
    check(routes(['base', "'/api/teams/:teamId/direct'"])).join(),
    /routes for 2 resources/,
  );
});

await test('tests share helpers, not each other; a browser spec names a part of the workspace', () => {
  assert.deepEqual(
    check({
      'web/chat/a.tsx': 'export function A() { return null; }',
      'tests/x-helpers.ts': 'export const h = 1;',
      'tests/x.test.ts': "import { h } from './x-helpers.js'; void h;",
      'tests/browser/chat.spec.ts': 'export {};',
      'tests/browser/shell.spec.ts': 'export {};',
    }),
    [],
  );
  assert.match(
    check({
      'tests/a.test.ts': 'export const a = 1;',
      'tests/b.test.ts': "import { a } from './a.test.js'; void a;",
    }).join(),
    /imports another test/,
  );
  assert.match(
    check({ 'tests/browser/everything.spec.ts': 'export {};' }).join(),
    /named after a web feature/,
  );
});
