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
    'web/a.ts':
      "import { b } from '../src/persistence/b.js'; export const a = b;",
    'src/persistence/b.ts': 'export const b = 1;',
  });
  refused({
    'web/chat/a.ts': "import { b } from '../tasks/b.js'; export const a = b;",
    'web/tasks/b.ts': 'export const b = 1;',
  });
  refused({
    'web/a.ts': "import { b } from './chat/b.js'; export const a = b;",
    'web/chat/b.ts': 'export const b = 1;',
  });
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
      'web/a.tsx':
        'export function A() { return null; } export const label = "a"; function Part() { return null; } void Part;',
      'web/use-b.ts': 'export function useB() { return 1; }',
    }),
    [],
  );
  assert.match(
    check({
      'web/a.tsx':
        'export function A() { return null; } export const B = memo(function B() { return null; });',
    }).join(),
    /gives 2 components or hooks/,
  );
  assert.match(
    check({
      'web/app.tsx':
        "import { useState } from 'react'; export function App() { const [a] = useState(0); return a; }",
    }).join(),
    /holds state/,
  );
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
