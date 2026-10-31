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
  assert.match(workflow, /push:\n    branches: \['\*\*'\]/);
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
      /(?:test:live|test:team-live|test:inbox-live|test:collaboration-live|t3:auth|release:check)|secrets\.|LLM_API_KEY/,
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
  const checkout =
    'uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
  const setupNode =
    'uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
  assert.ok(mainGuard > 0 && workflow.indexOf(checkout) > mainGuard);
  const untrusted = workflow.slice(
    workflow.indexOf('  authorize-dispatch:\n'),
    workflow.indexOf('  authenticated-live:\n'),
  );
  const trusted = workflow.slice(workflow.indexOf('  authenticated-live:\n'));
  assert.match(untrusted, /runs-on: ubuntu-24\\.04/);
  assert.match(trusted, /needs: authorize-dispatch/);
  const trustedCheckout = trusted.indexOf(checkout);
  assert.ok(trustedCheckout > 0);
  for (const condition of [
    'test "$GITHUB_EVENT_NAME" = "workflow_dispatch"',
    'test "$GITHUB_REF" = "refs/heads/main"',
    'test "$GITHUB_ACTOR" = "$GITHUB_REPOSITORY_OWNER"',
    'test "$GITHUB_TRIGGERING_ACTOR" = "$GITHUB_REPOSITORY_OWNER"',
  ]) {
    assert.ok(
      untrusted.includes(condition),
      'Missing GitHub-hosted owner dispatch check: ' + condition,
    );
    assert.ok(
      trusted.indexOf(condition) >= 0 &&
        trusted.indexOf(condition) < trustedCheckout,
      'Missing trusted runner recheck before checkout: ' + condition,
    );
  }
  assert.ok(workflow.includes(setupNode));
  assert.ok(workflow.includes('persist-credentials: false'));
  assert.ok(workflow.includes('group: kinmesh-native-owner-release'));
  assert.ok(workflow.includes('cancel-in-progress: false'));
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v\d+/);
  assert.ok(workflow.includes('npm run release:check'));
  assert.doesNotMatch(workflow, /continue-on-error\s*:/);
});

await test('CI: unattended native integration stays approval-required without secrets or model retries', () => {
  const workflow = source('../.github/workflows/live.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:|push:/);
  assert.match(workflow, /environment: live/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /executor: \[codex, grok\]/);
  assert.match(workflow, /approval-required/);
  assert.doesNotMatch(workflow, /secrets\.|npm |actions\/checkout/);
  assert.match(workflow, /steps\.owner-approval\.outcome == 'success'/);
  assert.match(workflow, /path: \.live-evidence\/\*\.json/);
  assert.match(workflow, /include-hidden-files: true/);
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
