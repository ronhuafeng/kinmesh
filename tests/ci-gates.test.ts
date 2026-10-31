import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8');
const scripts = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(JSON.parse(source('../package.json'))).scripts;

await test('CI: Foundation enforces typed, SQLite/process, architecture and audit checks', () => {
  const workflow = source('../.github/workflows/ci.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches: \[main\]/);
  for (const command of [
    'npm ci',
    'npm run build',
    'npm run lint',
    'npm run format:check',
    'npm test',
    'npm run db:generate',
    'npm run architecture',
    'npm audit --omit=dev',
  ]) {
    assert.ok(workflow.includes(command), 'Missing CI check: ' + command);
  }
  assert.ok(scripts.build?.includes('npm run typecheck'));
  assert.ok(
    workflow.includes('test -z "$(git status --porcelain -- drizzle)"'),
  );
  assert.doesNotMatch(workflow, /continue-on-error\s*:/);
});

await test('CI: genuine Chromium must run without a silent fallback', () => {
  const workflow = source('../.github/workflows/ci.yml');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches: \[main\]/);
  assert.equal(scripts['test:browser'], 'playwright test');
  assert.ok(workflow.includes('npx playwright install --with-deps chromium'));
  assert.ok(workflow.includes('npm run test:browser'));
  assert.doesNotMatch(workflow, /continue-on-error\s*:/);
});

await test('CI: no private OAuth or paid model runner in routine checks', () => {
  for (const path of ['ci.yml']) {
    const workflow = source('../.github/workflows/' + path);
    assert.doesNotMatch(
      workflow,
      /KINMESH_T3_(?:AUTH_FILE|ENDPOINT)|KINMESH_TEAM_T3_LIVE/,
    );
    assert.doesNotMatch(
      workflow,
      /(?:test:live|test:team-live|test:inbox-live|release:check)/,
    );
  }
  for (const required of [
    'test:live',
    'test:team-live',
    'test:inbox-live',
    'team:live:prepare',
    'release:check',
  ]) {
    assert.equal(typeof scripts[required], 'string');
  }
  const workflow = source('../.github/workflows/t3-live.yml');
  assert.match(workflow, /^on:\n  workflow_dispatch:\npermissions:/m);
  assert.ok(workflow.includes('runs-on: [self-hosted, kinmesh-t3-acceptance]'));
  const mainGuard = workflow.indexOf('test "$GITHUB_REF" = "refs/heads/main"');
  assert.ok(
    mainGuard > 0 && workflow.indexOf('uses: actions/checkout@v4') > mainGuard,
  );
  assert.ok(workflow.includes('npm run release:check'));
  assert.doesNotMatch(workflow, /continue-on-error\s*:/);
});

await test('CI: paid integration is explicit, isolated, complete and does not retry models', () => {
  const workflow = source('../.github/workflows/live.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:|push:/);
  assert.match(workflow, /environment: live/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /executor: \[codex, grok\]/);
  for (const secret of ['LLM_API_KEY', 'CODEX_BASE_URL', 'GROK_BASE_URL'])
    assert.ok(workflow.includes('secrets.' + secret));
  assert.match(workflow, /path: \.live-evidence\/\*\.json/);
  assert.doesNotMatch(
    workflow,
    /continue-on-error:|pull_request_target|self-hosted/,
  );
  assert.equal(
    scripts['test:collaboration-live'],
    'playwright test --config playwright.live.config.ts',
  );
  assert.match(source('../playwright.live.config.ts'), /retries: 0/);
});
