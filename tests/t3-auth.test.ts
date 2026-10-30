import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  Endpoint,
  Credential,
  loadCredential,
  saveCredential,
  storedProvider,
} from '../src/adapters/t3/oauth.js';
import { ExecutionFailure } from '../src/domain/execution.js';
import { fixture } from './helpers.js';

const credential = Credential.parse({
  endpoint: 'https://t3.invalid/mcp',
  environmentId: 'fixture-environment',
  client: { client_id: 'fixture-client' },
  tokens: {
    access_token: 'fake-unit-only-token',
    token_type: 'Bearer',
    scope: 'orchestration:read orchestration:operate',
  },
});
await test('AUTH UNIT: transport accepts only HTTPS or loopback with no URL credentials', () => {
  for (const url of [
    'http://public.test/mcp',
    'https://user:secret@t3.test/mcp',
    'https://t3.test/private',
    'https://t3.test/mcp?token=secret',
    'https://t3.test/mcp#secret',
  ])
    assert.equal(Endpoint.safeParse(url).success, false);
  assert.equal(Endpoint.safeParse('http://127.0.0.1:3773/mcp').success, true);
  assert.equal(Endpoint.safeParse('https://t3.test/mcp').success, true);
});
await test('AUTH UNIT: credentials are private, endpoint-bound and scope-validated', () => {
  const f = fixture();
  const file = join(f.directory, 'oauth.json');
  try {
    saveCredential(file, credential);
    assert.equal(
      loadCredential(file, credential.endpoint).tokens.scope,
      credential.tokens.scope,
    );
    assert.throws(
      () => loadCredential(file, 'https://other.test/mcp'),
      (e) => e instanceof ExecutionFailure && e.kind === 'authentication',
    );
    chmodSync(file, 0o644);
    assert.throws(() => loadCredential(file, credential.endpoint));
    const excessive = {
      ...credential,
      tokens: {
        ...credential.tokens,
        scope: 'orchestration:read settings:write',
      },
    };
    assert.throws(() => {
      saveCredential(file, excessive);
    });
    writeFileSync(file, JSON.stringify(excessive));
    chmodSync(file, 0o600);
    assert.throws(() => loadCredential(file, credential.endpoint));
    writeFileSync(file, 'not JSON', { mode: 0o600 });
    assert.throws(() => loadCredential(file, credential.endpoint));
    saveCredential(file, credential);
    const link = join(f.directory, 'link.json');
    symlinkSync(file, link);
    assert.throws(() => loadCredential(link, credential.endpoint));
    assert.ok(!readFileSync(file, 'utf8').includes('password'));
  } finally {
    f.cleanup();
  }
});
await test('AUTH UNIT: noninteractive SDK auth never silently opens consent or switches authorities', () => {
  const provider = storedProvider(credential);
  assert.throws(
    () => provider.redirectToAuthorization(new URL('https://t3.invalid/oauth')),
    (e) => e instanceof ExecutionFailure && e.kind === 'authentication',
  );
  assert.throws(() => provider.saveTokens(credential.tokens));
  assert.throws(() => provider.codeVerifier());
});
await test('LIVE GATE NEGATIVE: missing credentials fail closed, never skipped or green', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/t3-live.ts'],
    {
      cwd: new URL('..', import.meta.url),
      env: { PATH: process.env.PATH ?? '', KINMESH_T3_LIVE: '1' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /T3_LIVE_GATE FAIL/);
  assert.doesNotMatch(result.stdout, /T3_LIVE_GATE PASS/);
});
