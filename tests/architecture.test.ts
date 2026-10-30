import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectManifest,
  inspectSource,
  checkRepository,
} from '../scripts/boundaries.js';

await test('real repository obeys boundaries', () => {
  assert.deepEqual(checkRepository(process.cwd()), []);
});
await test('negative architecture fixtures detect static/dynamic private imports and manifest aliases', () => {
  assert.ok(
    inspectSource('src/bad.ts', 'import x from "@t3tools/core";').length > 0,
  );
  assert.ok(
    inspectSource(
      'src/bad.ts',
      'export { x } from "t3code/apps/server/private";',
    ).length > 0,
  );
  assert.ok(
    inspectSource('src/bad.ts', 'const x = import("@t3tools/private");')
      .length > 0,
  );
  assert.ok(
    inspectManifest(
      'package.json',
      JSON.stringify({ dependencies: { innocent: 'npm:@t3tools/core@1' } }),
    ).length > 0,
  );
  assert.ok(
    inspectManifest(
      'package-lock.json',
      JSON.stringify({ packages: { 'node_modules/@t3tools/core': {} } }),
    ).length > 0,
  );
});
await test('negative fixtures detect private SQLite, WebSocket, suppressed typing and domain coupling', () => {
  assert.ok(
    inspectSource(
      'src/bad.ts',
      'new Database("/home/user/.t3/userdata/statev2.sqlite")',
    ).length > 0,
  );
  assert.ok(
    inspectSource(
      'src/bad.ts',
      'readFileSync("/home/user/.t3/userdata/statev2.sqlite")',
    ).length > 0,
  );
  assert.ok(
    inspectSource('src/bad.ts', 'new WebSocket("wss://example.test")').length >
      0,
  );
  assert.ok(
    inspectSource(
      'src/domain/bad.ts',
      'import { x } from "../persistence/store.js"',
    ).length > 0,
  );
  assert.ok(
    inspectSource('src/bad.ts', '// @ts-' + 'ignore\nlet x: any;').length > 0,
  );
});
await test('permitted external contract and Kinmesh storage are accepted', () => {
  assert.deepEqual(
    inspectSource(
      'src/adapter.ts',
      'import { Client } from "@modelcontextprotocol/sdk/client/index.js"; new Database(".store/kinmesh.sqlite");',
    ),
    [],
  );
});
await test('negative fixtures detect writes to private T3 files and CLI modification', () => {
  assert.ok(
    inspectSource(
      'src/bad.ts',
      'writeFileSync("/home/user/.t3/config", "changed")',
    ).length > 0,
  );
  assert.ok(
    inspectSource('src/bad.ts', 'execFileSync("t3", ["update"])').length > 0,
  );
});
await test('negative source fixture detects a private resource assigned before opening', () => {
  assert.ok(
    inspectSource(
      'src/bad.ts',
      'const path = "/home/user/.t3/userdata/statev2.sqlite"; new Database(path);',
    ).length > 0,
  );
});
