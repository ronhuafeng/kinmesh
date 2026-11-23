import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSources } from '../scripts/structure/index.js';
import { resourceOf } from '../scripts/structure/responsibility.js';
import { sourcesFrom } from '../scripts/structure/sources.js';

// `npm run architecture` (CI) checks the repository; these prove each rule
// both refuses what it should and lets the rest through.
const check = (files: Record<string, string>) =>
  checkSources(sourcesFrom(files));

await test('layers depend downward only, and nothing imports in a circle', () => {
  assert.deepEqual(
    check({
      'src/domain/a.ts': 'export const a = 1;',
      'src/persistence/b.ts':
        "import { a } from '../domain/a.js'; export const b = a;",
      'web/chat/c.ts':
        "import { a } from '../../src/domain/a.js'; export const c = a;",
      'tests/d.test.ts': "import { b } from '../src/persistence/b.js'; void b;",
    }),
    [],
  );
  const refused = (files: Record<string, string>) => {
    assert.equal(check(files).length, 1, JSON.stringify(files));
  };
  // Up, sideways between processes, from web into storage, between web
  // features, and from shared up into a feature.
  refused({
    'src/domain/a.ts':
      "import { b } from '../persistence/b.js'; export const a = b;",
    'src/persistence/b.ts': 'export const b = 1;',
  });
  refused({
    'src/server/a.ts': "import { b } from '../inbox/b.js'; export const a = b;",
    'src/inbox/b.ts': 'export const b = 1;',
  });
  refused({
    'web/shared/a.ts':
      "import { b } from '../../src/persistence/b.js'; export const a = b;",
    'src/persistence/b.ts': 'export const b = 1;',
  });
  refused({
    'web/chat/a.ts': "import { b } from '../tasks/b.js'; export const a = b;",
    'web/tasks/b.ts': 'export const b = 1;',
  });
  refused({
    'web/shared/a.ts': "import { b } from '../chat/b.js'; export const a = b;",
    'web/chat/b.ts': 'export const b = 1;',
  });
  // The root of web holds only the entries and the app.
  refused({ 'web/helpers.ts': 'export const h = 1;' });
  refused({
    'src/domain/a.ts':
      "import { t } from '../../tests/t.js'; export const a = t;",
    'tests/t.ts': 'export const t = 1;',
  });
  assert.match(
    check({
      'src/domain/a.ts': "import { b } from './b.js'; export const a = b;",
      'src/domain/b.ts': "import { a } from './a.js'; export const b = a;",
    }).join(),
    /import cycle/,
  );
});

await test('a UI file gives one component or hook; the shell holds no state', () => {
  assert.deepEqual(
    check({
      'web/shared/a.tsx':
        'export function A() { return null; } export const label = "a"; function Part() { return null; } void Part;',
      'web/shared/use-b.ts': 'export function useB() { return 1; }',
    }),
    [],
  );
  assert.match(
    check({
      'web/shared/a.tsx':
        'export function A() { return null; } export const B = memo(function B() { return null; });',
    }).join(),
    /gives 2 components or hooks/,
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
      check({ 'src/inbox/main.ts': source }).join(),
      /only wires modules together/,
      source,
    );
  };
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
