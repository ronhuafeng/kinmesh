import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Stable safety properties of the workflows, not their command lists.
const source = (path: string) =>
  readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const workflow = (name: string) => source('.github/workflows/' + name);
const WORKFLOWS = ['ci.yml', 'live.yml', 't3-live.yml'];
const MANUAL = ['live.yml', 't3-live.yml'];
const OWNER_GUARDS = [
  'test "$GITHUB_EVENT_NAME" = "workflow_dispatch"',
  'test "$GITHUB_REF" = "refs/heads/main"',
  'test "$GITHUB_ACTOR" = "$GITHUB_REPOSITORY_OWNER"',
  'test "$GITHUB_TRIGGERING_ACTOR" = "$GITHUB_REPOSITORY_OWNER"',
];

/** Each job's text, keyed by job id. */
function jobs(text: string) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const parts = body.split(/^ {2}([a-z][\w-]*):\n/m).slice(1);
  const out = new Map<string, string>();
  for (let i = 0; i < parts.length; i += 2)
    out.set(parts[i] ?? '', parts[i + 1] ?? '');
  return out;
}
const triggers = (text: string) =>
  text.slice(text.indexOf('\non:\n') + 5, text.indexOf('\npermissions:'));

await test('every workflow pins actions by SHA, never swallows failures and drops checkout credentials', () => {
  for (const name of WORKFLOWS) {
    const text = workflow(name);
    const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1] ?? '');
    assert.ok(uses.length > 0, name);
    for (const action of uses)
      assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, name);
    assert.doesNotMatch(text, /continue-on-error\s*:/, name);
    assert.doesNotMatch(text, /pull_request_target/, name);
    const checkouts = text.split('uses: actions/checkout@').slice(1);
    for (const after of checkouts)
      assert.match(after, /^\S+.*\n\s+with:\n\s+persist-credentials: false/);
  }
});

await test('PR CI holds no secrets, credentials or paid/live runs', () => {
  const text = workflow('ci.yml');
  assert.match(triggers(text), /pull_request:/);
  assert.doesNotMatch(
    text,
    /secrets\.|LLM_API_KEY|KINMESH_T3_(?:AUTH_FILE|ENDPOINT)|KINMESH_TEAM_T3_LIVE|self-hosted/,
  );
  assert.doesNotMatch(
    text,
    /test:live|test:team-live|test:inbox-live|test:collaboration-live|t3:auth|release:check|tests\/live/,
  );
});

await test('paid and credential-bearing runs are manual, owner-only on main, guarded before checkout', () => {
  for (const name of MANUAL) {
    const text = workflow(name);
    // Dispatch is the only trigger; only its own inputs may follow.
    assert.match(triggers(text), /^ {2}workflow_dispatch:(?:\n {4}.*)*$/, name);
    assert.match(text, /cancel-in-progress: false/, name);
    for (const [job, body] of jobs(text)) {
      const checkout = body.indexOf('uses: actions/checkout@');
      if (checkout < 0) continue;
      for (const guard of OWNER_GUARDS) {
        const at = body.indexOf(guard);
        assert.ok(
          at >= 0 && at < checkout,
          `${name} ${job}: missing guard before checkout: ${guard}`,
        );
      }
    }
  }
  // Model-key runs stay on GitHub-hosted runners.
  const live = workflow('live.yml');
  assert.doesNotMatch(live, /self-hosted/);
  const [collaboration] = jobs(live).values();
  assert.ok(
    collaboration &&
      collaboration.indexOf('test "$RUNNER_ENVIRONMENT" = "github-hosted"') <
        collaboration.indexOf('uses: actions/checkout@'),
  );
  // The owner's OAuth runner is reserved only after a GitHub-hosted owner check,
  // and never gets privileged system package installs.
  const t3 = jobs(workflow('t3-live.yml'));
  const authorize = t3.get('authorize-dispatch') ?? '';
  const trusted = t3.get('authenticated-live') ?? '';
  for (const guard of OWNER_GUARDS) assert.ok(authorize.includes(guard));
  assert.match(authorize, /runs-on: ubuntu-/);
  assert.match(trusted, /needs: authorize-dispatch/);
  assert.match(trusted, /runs-on: \[self-hosted, kinmesh-t3-acceptance\]/);
  assert.doesNotMatch(trusted, /--with-deps/);
});

await test('live acceptance never retries and the release runs Chromium before native models', () => {
  assert.match(source('playwright.live.config.ts'), /retries: 0/);
  const release = z
    .object({ scripts: z.object({ 'release:check': z.string() }) })
    .parse(JSON.parse(source('package.json'))).scripts['release:check'];
  const commands = release.split(' && ');
  const browser = commands.indexOf('npm run test:browser');
  const native = commands.findIndex((c) => c.includes('release-live.ts'));
  assert.ok(browser >= 0 && native > browser);
});
