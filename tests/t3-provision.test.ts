import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authority,
  loadCredential,
  saveCredential,
  signInEnded,
} from '../src/adapters/t3/oauth.js';
import { endProvisionedT3, provisionedT3 } from '../src/server/provision.js';
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
    // When the session ends, as T3 issued it: an ended one makes work wait.
    assert.equal(first.expiresAt, '2026-12-16T00:00:00.000Z');
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

/**
 * Proves a hub the deployment no longer connects stops using the session the
 * deployment issued: it reads as ended, so deliveries wait for a person's
 * sign-in instead of being refused by T3. A person's sign-in is kept.
 */
await test('a hub no longer connected by the deployment ends its session; a person’s sign-in stays', async () => {
  const f = await agentFixture();
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-provision-'));
  try {
    const directory = join(dir, 'managed');
    const credentialFile = join(dir, 'session.json');
    // Nothing signed in: nothing to end.
    assert.equal(endProvisionedT3(directory), false);
    writeFileSync(credentialFile, issued('deployment-token'));
    await provisionedT3(
      f.store,
      directory,
      { endpoint, credentialFile },
      t3(),
    )();
    const now = Date.parse('2026-11-20T00:00:00.000Z');
    assert.equal(endProvisionedT3(directory, now), true);
    const ended = loadCredential(t3AuthFile(directory), endpoint);
    assert.equal(signInEnded(ended, now), true);
    assert.equal(ended.tokens.access_token, 'deployment-token');
    assert.equal(statSync(t3AuthFile(directory)).mode & 0o777, 0o600);
    // Already ended: left as it is.
    assert.equal(endProvisionedT3(directory, now + 1000), false);

    // A person's sign-in carries its OAuth client and is never ended here.
    const person = {
      ...ended,
      client: { client_id: 'person-client' },
      expiresAt: '2026-12-20T00:00:00.000Z',
    };
    saveCredential(t3AuthFile(directory), person, { replace: true });
    assert.equal(endProvisionedT3(directory, now), false);
    assert.equal(
      loadCredential(t3AuthFile(directory), endpoint).expiresAt,
      person.expiresAt,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await f.dispose();
  }
});
