import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Manifest = z.object({
  scripts: z.object({
    'release:check': z.string(),
    'test:browser': z.string(),
    'test:live': z.string(),
    'test:team-live': z.string(),
    'test:inbox-live': z.string(),
  }),
});

await test('release check runs an actual Chromium browser gate before every native model acceptance', () => {
  const manifest = Manifest.parse(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
  );
  assert.equal(manifest.scripts['test:browser'], 'playwright test');
  const commands = manifest.scripts['release:check'].split(' && ');
  function index(command: string) {
    const position = commands.indexOf(command);
    assert.notEqual(position, -1, 'Missing mandatory gate: ' + command);
    return position;
  }
  const build = index('npm run build');
  const browser = index('npm run test:browser');
  assert.ok(build < browser, 'The real browser requires built workspace assets');
  for (const native of [
    'npm run test:live',
    'npm run test:team-live',
    'npm run test:inbox-live',
  ])
    assert.ok(
      browser < index(native),
      'Browser failures must block native model Runs',
    );
});

await test('trusted T3 release workflow provisions Chromium without privileged package installation', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/t3-live.yml', import.meta.url),
    'utf8',
  );
  assert.ok(workflow.includes('workflow_dispatch:'));
  assert.ok(workflow.includes('runs-on: [self-hosted, kinmesh-t3-acceptance]'));
  const install = workflow.indexOf('- run: npm ci');
  const chromium = workflow.indexOf('- run: npx playwright install chromium');
  const release = workflow.indexOf('- run: npm run release:check');
  assert.ok(install >= 0 && chromium > install && release > chromium);
  assert.ok(!workflow.includes('--with-deps'));
});
