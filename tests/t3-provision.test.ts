import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authority, loadCredential } from '../src/adapters/t3/oauth.js';
import { provisionedT3 } from '../src/server/provision.js';
import { t3AuthFile } from '../src/inbox/managed.js';
import { agentFixture } from './agent-helpers.js';
import { environment } from './t3-helpers.js';

const endpoint = 'https://t3.example/mcp';
/** T3 answering its environment descriptor; no other request is made. */
const t3 = (): typeof fetch => (input) => {
  assert.equal(
    String(input instanceof Request ? input.url : input),
    'https://t3.example/.well-known/t3/environment',
  );
  return Promise.resolve(Response.json(environment));
};
const issued = (
  token: string,
  scopes = ['orchestration:read', 'orchestration:operate'],
) =>
  JSON.stringify({
    sessionId: 'fixture-session',
    token,
    method: 'bearer-access-token',
    scopes,
    expiresAt: '2026-12-16T00:00:00.000Z',
  });

await test('the deployment’s T3 session connects the team; a renewed one is the same authority', async () => {
  const f = await agentFixture();
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-provision-'));
  try {
    const directory = join(dir, 'managed');
    const credentialFile = join(dir, 'session.json');
    writeFileSync(credentialFile, issued('first-token'));
    const sync = provisionedT3(
      f.store,
      directory,
      { endpoint, credentialFile },
      t3(),
    );
    assert.equal(await sync(), true);
    const first = loadCredential(t3AuthFile(directory), endpoint);
    assert.equal(first.tokens.access_token, 'first-token');
    assert.equal(first.environmentId, environment.environmentId);
    assert.equal(statSync(t3AuthFile(directory)).mode & 0o777, 0o600);
    const connection = await f.store.managed.connection(f.principal, f.teamId);
    assert.equal(connection?.endpoint, endpoint);
    assert.equal(connection.environmentId, environment.environmentId);
    // Nothing changed: nothing is written again.
    assert.equal(await sync(), false);

    // Renewed: the new token is used, as the same authority, so work under
    // way goes on; the team's connection is unchanged.
    writeFileSync(credentialFile, issued('second-token'));
    assert.equal(await sync(), true);
    const second = loadCredential(t3AuthFile(directory), endpoint);
    assert.equal(second.tokens.access_token, 'second-token');
    assert.equal(authority(second), authority(first));
    assert.equal(
      (await f.store.managed.connection(f.principal, f.teamId))?.connectedAt,
      connection.connectedAt,
    );

    // Other scopes are another authority.
    writeFileSync(
      credentialFile,
      issued('third-token', [
        'orchestration:read',
        'orchestration:operate',
        'settings:write',
        'source-control:write',
      ]),
    );
    assert.equal(await sync(), true);
    assert.notEqual(
      authority(loadCredential(t3AuthFile(directory), endpoint)),
      authority(first),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await f.dispose();
  }
});
