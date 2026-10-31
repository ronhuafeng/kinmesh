import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Native } from './live/native.js';
import { requireOwnerNativeApproval } from './live/safety.js';
import { runInNewContext } from 'node:vm';

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

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = source('../.github/workflows/live.yml');
const firstStep = () => {
  const steps = workflow.split('    steps:\n')[1] ?? '';
  const first = steps.split(/\n      - /)[0] ?? '';
  return first.split('        run: |\n')[1]?.replace(/^          /gm, '') ?? '';
};

await test('SAFETY REGRESSION: first executable step rejects non-main before checkout/npm', () => {
  const script = firstStep();
  assert.match(script, /GITHUB_REF/);
  for (const ref of [
    'refs/heads/topic',
    'refs/pull/46/merge',
    'refs/tags/main',
    '',
  ]) {
    const result = spawnSync(
      'bash',
      ['-e', '-c', script + '\nprintf REACHED'],
      {
        env: { PATH: process.env.PATH, GITHUB_REF: ref },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /REACHED/);
  }
  const main = spawnSync('bash', ['-e', '-c', script], {
    env: { PATH: process.env.PATH, GITHUB_REF: 'refs/heads/main' },
  });
  assert.equal(main.status, 0);
});

await test('SAFETY REGRESSION: main dispatch fails approval-required before checkout or secrets', () => {
  const steps = workflow.split('    steps:\n')[1] ?? '';
  const block =
    steps
      .split('      - name: Owner-native approval-required')[1]
      ?.split(/\n      - /)[0] ?? '';
  const script =
    block.split('        run: |\n')[1]?.replace(/^          /gm, '') ?? '';
  assert.ok(script);
  const result = spawnSync('bash', ['-e', '-c', script + '\nprintf REACHED'], {
    env: {
      PATH: process.env.PATH,
      GITHUB_REF: 'refs/heads/main',
      LLM_API_KEY: 'synthetic-secret-canary',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /approval-required/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /REACHED|synthetic-secret-canary/,
  );
  assert.doesNotMatch(
    workflow,
    /secrets\.|continue-on-error:|npm |actions\/checkout/,
  );
});

for (const runner of [true, false]) {
  for (const readOnly of [true, false]) {
    await test(`SAFETY REGRESSION: OAuth ${readOnly ? 'Read only' : 'Supervised'} cannot operate a native consent page (runner=${String(runner)})`, async (t) => {
      environment(t, {
        GITHUB_ACTIONS: runner ? 'true' : undefined,
        LLM_API_KEY: 'synthetic-secret-canary',
      });
      const native = new Native('/unused', 'codex');
      // A trap fails before the old OAuth flow can reach discovery or any network.
      Object.defineProperty(native, 'page', {
        get() {
          throw new Error('NATIVE_PAGE_ACCESSED');
        },
      });
      await assert.rejects(native.oauth(readOnly), {
        message: 'approval-required',
      });
    });
  }
}

await test('SAFETY REGRESSION: runner cannot configure, start or pair native services with model credentials', async (t) => {
  environment(t, {
    GITHUB_ACTIONS: 'true',
    LLM_API_KEY: 'synthetic-secret-canary',
    KINMESH_T3_BINARY: '/nonexistent-kinmesh-safety-test-binary',
  });
  const root = mkdtempSync(join(tmpdir(), 'kinmesh-safety-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const native = new Native(root, 'codex');
  assert.throws(
    () => {
      native.configure('developer', '', '', []);
    },
    {
      message: 'approval-required',
    },
  );
  await assert.rejects(native.start(), { message: 'approval-required' });
  await assert.rejects(native.addProviders(), { message: 'approval-required' });
  assert.deepEqual(readdirSync(root), []);
});

await test('SAFETY REGRESSION: collaboration blocks before setup and never clicks native Approve', () => {
  const collaboration = source('./live/collaboration.spec.ts');
  const body = collaboration.slice(collaboration.indexOf('async () => {'));
  assert.match(
    body.slice(0, 100),
    /^async \(\) => \{\n  requireOwnerNativeApproval\(\);/,
  );
  const approve =
    collaboration.split('function approve(')[1]?.split('  let crashed')[0] ??
    '';
  assert.match(approve, /requireOwnerNativeApproval\(\)/);
  assert.throws(
    () => {
      runInNewContext('(function approve(' + approve + ')()', {
        requireOwnerNativeApproval,
      });
    },
    { message: 'approval-required' },
  );
  assert.doesNotMatch(approve, /\.click\(|name: 'Approve'/);
  assert.doesNotMatch(
    source('./live/native.ts'),
    /name: \/authorize\|allow\|approve|callbackReceiver|page\.goto\(url\.href\)/,
  );
});

await test('SAFETY NEGATIVE: approval flags, simulated Human and CI review cannot supply owner-native consent', (t) => {
  environment(t, {
    GITHUB_ACTIONS: 'true',
    LLM_API_KEY: 'synthetic-secret-canary',
    KINMESH_OWNER_APPROVED: 'true',
    KINMESH_NATIVE_APPROVAL: 'true',
    KINMESH_SIMULATED_HUMAN: 'true',
  });
  assert.throws(requireOwnerNativeApproval, { message: 'approval-required' });
});

await test('SAFETY NEGATIVE: a nonempty false runner marker and missing API key cannot bypass native startup guard', async (t) => {
  environment(t, {
    GITHUB_ACTIONS: 'false',
    LLM_API_KEY: undefined,
    KINMESH_T3_BINARY: '/nonexistent-kinmesh-safety-test-binary',
  });
  const native = new Native('/unused', 'grok');
  await assert.rejects(native.start(), { message: 'approval-required' });
});

await test('SAFETY: blocked workflow preserves PR45 JSON-only hidden evidence settings without unconditional upload', () => {
  assert.match(workflow, /path: \.live-evidence\/\*\.json/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) && steps\.owner-approval\.outcome == 'success' \}\}/,
  );
  assert.doesNotMatch(
    workflow,
    /path:.*(?:log|sqlite|home|oauth)|printenv|set -x/,
  );
});
