import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Process } from './live/processes.js';
import { Native } from './live/native.js';
import { requireLiveDispatch, requireDisposableRoot } from './live/safety.js';

function environment(t: TestContext, values: NodeJS.ProcessEnv) {
  const original = process.env;
  t.after(() => {
    process.env = original;
  });
  process.env = Object.fromEntries(
    Object.entries({ ...original, ...values }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}
const eligible = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY_OWNER: 'owner',
  GITHUB_ACTOR: 'owner',
  GITHUB_TRIGGERING_ACTOR: 'owner',
  RUNNER_ENVIRONMENT: 'github-hosted',
};
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kinmesh-live-')));
  chmodSync(root, 0o700);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const workflow = readFileSync(
  new URL('../.github/workflows/live.yml', import.meta.url),
  'utf8',
);
const first =
  (workflow.split('    steps:\n')[1]?.split(/\n      - /)[0] ?? '')
    .split('        run: |\n')[1]
    ?.replace(/^          /gm, '') ?? '';

await test('SAFETY: workflow and runtime reject non-main, non-owner, reruns and untrusted runners before work', (t) => {
  for (const changed of [
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_REF: 'refs/tags/main' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_ACTOR: 'writer' },
    { GITHUB_TRIGGERING_ACTOR: 'writer' },
    { GITHUB_REPOSITORY_OWNER: '' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
  ]) {
    const env = { PATH: process.env.PATH, ...eligible, ...changed };
    const result = spawnSync('bash', ['-e', '-c', first + '\nprintf REACHED'], {
      env,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /REACHED/);
    environment(t, env);
    assert.throws(requireLiveDispatch, /OWNER_HOSTED_MAIN_DISPATCH_REQUIRED/);
  }
  environment(t, eligible);
  requireLiveDispatch();
  assert.equal(
    spawnSync('bash', ['-e', '-c', first], {
      env: { PATH: process.env.PATH, ...eligible },
    }).status,
    0,
  );
});

await test('SAFETY: false runner markers and approval flags do not authorize execution', (t) => {
  environment(t, {
    ...eligible,
    GITHUB_ACTIONS: 'false',
    KINMESH_OWNER_APPROVED: 'true',
    KINMESH_NATIVE_APPROVAL: 'true',
  });
  assert.throws(requireLiveDispatch, /OWNER_HOSTED_MAIN_DISPATCH_REQUIRED/);
});

await test('SAFETY: only private canonical current-user temporary fixture directories qualify', (t) => {
  const root = fixture(t);
  requireDisposableRoot(root);
  assert.throws(() => {
    requireDisposableRoot(process.cwd());
  }, /PRIVATE_DISPOSABLE_ROOT_REQUIRED/);
  chmodSync(root, 0o755);
  assert.throws(() => {
    requireDisposableRoot(root);
  }, /PRIVATE_DISPOSABLE_ROOT_REQUIRED/);
  chmodSync(root, 0o700);
  const alias = root + 'Alias';
  symlinkSync(root, alias);
  t.after(() => {
    rmSync(alias);
  });
  assert.throws(() => {
    requireDisposableRoot(alias);
  }, /PRIVATE_DISPOSABLE_ROOT_REQUIRED/);
});

await test('SAFETY: eligible dispatch alone cannot configure, pair or consent against a shared server', async (t) => {
  environment(t, eligible);
  const native = new Native(fixture(t), 'codex');
  native.origin = 'http://127.0.0.1:3773';
  native.endpoint = native.origin + '/mcp';
  Object.defineProperty(native, 'page', {
    get() {
      throw new Error('SHARED_PAGE_ACCESSED');
    },
  });
  assert.throws(() => {
    native.configure('developer', '', '', []);
  }, /DISPOSABLE_SERVER_REQUIRED/);
  await assert.rejects(native.addProviders(), /DISPOSABLE_SERVER_REQUIRED/);
  await assert.rejects(native.oauth(true), /DISPOSABLE_SERVER_REQUIRED/);
  await assert.rejects(native.oauth(false), /DISPOSABLE_SERVER_REQUIRED/);
});

await test('SAFETY: invalid hosted dispatch stops native startup before binary or page access', async (t) => {
  environment(t, {
    ...eligible,
    GITHUB_ACTOR: 'writer',
    KINMESH_T3_BINARY: '/nonexistent-safety-canary',
  });
  await assert.rejects(
    new Native(fixture(t), 'grok').start(),
    /OWNER_HOSTED_MAIN_DISPATCH_REQUIRED/,
  );
});

await test('SAFETY: evidence upload remains failure-inclusive JSON only and does not expose private state', () => {
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /path: \.live-evidence\/\*\.json/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(
    workflow,
    /path:.*(?:log|sqlite|home|oauth)|printenv|set -x/,
  );
});

await test('SAFETY: a signal-terminated owned child cannot authorize native browser actions', async (t) => {
  environment(t, eligible);
  const root = fixture(t);
  const native = new Native(root, 'codex');
  const server = new Process(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { PATH: process.env.PATH },
    join(root, 'child.log'),
  );
  t.after(() => server.stop());
  server.start();
  const child = server.child;
  assert.ok(child);
  await once(child, 'spawn');
  native.server = server;
  native.origin = 'http://127.0.0.1:9999';
  native.endpoint = native.origin + '/mcp';
  // Synthetic setup identity isolates the real Node signal-exit regression.
  Object.defineProperty(native, 'ownedOrigin', { value: native.origin });
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, 'SIGTERM');
  Object.defineProperty(native, 'page', {
    get() {
      throw new Error('DEAD_SERVER_PAGE_ACCESSED');
    },
  });
  await assert.rejects(native.oauth(true), /DISPOSABLE_SERVER_REQUIRED/);
});
