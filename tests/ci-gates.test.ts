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
  assert.match(workflow, /^on: \[push, pull_request\]$/m);
  for (const command of [
    'npm ci',
    'npm run build',
    'npm run typecheck',
    'npm run lint',
    'npm run format:check',
    'npm test',
    'npm run db:generate',
    'npm run architecture',
    'npm audit --omit=dev',
  ]) {
    assert.ok(workflow.includes(command), 'Missing CI check: ' + command);
  }
  assert.ok(
    workflow.includes('test -z "$(git status --porcelain -- drizzle)"'),
  );
  assert.doesNotMatch(workflow, /continue-on-error\s*:/);
});

await test('CI: genuine Chromium runs on push/PR without silent fallback', () => {
  const workflow = source('../.github/workflows/browser.yml');
  assert.match(workflow, /^on: \[push, pull_request\]$/m);
  assert.equal(scripts['test:browser'], 'playwright test');
  assert.ok(workflow.includes('npx playwright install --with-deps chromium'));
  assert.ok(workflow.includes('npm run test:browser'));
  assert.doesNotMatch(workflow, /continue-on-error\s*:/);
});

await test('CI: native Provider/model gates exist only on explicit trusted manual acceptance path', () => {
  for (const path of ['ci.yml', 'browser.yml']) {
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
    assert.ok(scripts[required]?.length);
  }
  const workflow = source('../.github/workflows/t3-live.yml');
  assert.match(workflow, /^on:\n  workflow_dispatch:\npermissions:/m);
  assert.ok(workflow.includes('runs-on: [self-hosted, kinmesh-t3-acceptance]'));
  const mainGuard = workflow.indexOf('test "$GITHUB_REF" = "refs/heads/main"');
  const checkout = workflow.indexOf('uses: actions/checkout@v4');
  assert.ok(mainGuard > 0 && checkout > mainGuard);
  assert.ok(workflow.includes('npm run release:check'));
  assert.doesNotMatch(workflow, /continue-on-error\s*:/);
});
