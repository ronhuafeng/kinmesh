import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authority,
  loadCredential,
  saveCredential,
  signInEnded,
} from '../src/adapters/t3/oauth.js';
import {
  endProvisionedT3,
  provisionedT3,
  separateDeploymentSession,
} from '../src/server/provision.js';
import { t3AuthFile, t3DeploymentFile } from '../src/runtime/managed.js';
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
/** T3 reporting the session's ceiling: what an issued session gets. */
const supervised = () => Promise.resolve('approval-required' as const);
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
      supervised,
    );
    assert.equal(await sync(), true);
    // Kept apart from a person's sign-in, which stays theirs.
    assert.equal(existsSync(t3AuthFile(directory)), false);
    const first = loadCredential(t3DeploymentFile(directory), endpoint);
    assert.equal(first.tokens.access_token, 'first-token');
    assert.equal(first.environmentId, environment.environmentId);
    // What its runs launch in, as T3 reports it.
    assert.equal(first.ceiling, 'approval-required');
    // When the session ends, as T3 issued it: an ended one makes work wait.
    assert.equal(first.expiresAt, '2026-12-16T00:00:00.000Z');
    assert.equal(statSync(t3DeploymentFile(directory)).mode & 0o777, 0o600);
    const connection = await f.store.managed.connection(f.principal, f.teamId);
    assert.equal(connection?.endpoint, endpoint);
    assert.equal(connection.environmentId, environment.environmentId);
    // Nothing changed: nothing is written again.
    assert.equal(await sync(), false);

    // Renewed: the new token is used, as the same authority, so work under
    // way goes on; the team's connection is unchanged.
    writeFileSync(credentialFile, issued('second-token'));
    assert.equal(await sync(), true);
    const second = loadCredential(t3DeploymentFile(directory), endpoint);
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
      authority(loadCredential(t3DeploymentFile(directory), endpoint)),
      authority(first),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await f.dispose();
  }
});

/**
 * Proves a hub the deployment no longer connects stops using the session the
 * deployment issued: it reads as ended, so runs use a person's sign-in or
 * wait for one instead of being refused by T3. A person's sign-in is kept.
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
      supervised,
    )();
    const now = Date.parse('2026-11-20T00:00:00.000Z');
    const deployment = loadCredential(t3DeploymentFile(directory), endpoint);
    const person = {
      ...deployment,
      client: { client_id: 'person-client' },
      tokens: { ...deployment.tokens, access_token: 'person-token' },
      expiresAt: '2026-12-20T00:00:00.000Z',
    };
    saveCredential(t3AuthFile(directory), person, { replace: true });
    assert.equal(endProvisionedT3(directory, now), true);
    const ended = loadCredential(t3DeploymentFile(directory), endpoint);
    assert.equal(signInEnded(ended, now), true);
    assert.equal(ended.tokens.access_token, 'deployment-token');
    assert.equal(statSync(t3DeploymentFile(directory)).mode & 0o777, 0o600);
    // Already ended: left as it is.
    assert.equal(endProvisionedT3(directory, now + 1000), false);
    // A person's sign-in is never ended here.
    assert.equal(
      loadCredential(t3AuthFile(directory), endpoint).expiresAt,
      person.expiresAt,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await f.dispose();
  }
});

/**
 * Proves a deployment's session found where a person's sign-in goes (it has
 * no OAuth client) moves to the deployment's own file, so it is never taken
 * for a person's sign-in that asks everyone to sign in again; a person's
 * stays where it is.
 */
await test('a deployment’s session kept with a person’s sign-in moves to its own file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-provision-'));
  try {
    const directory = join(dir, 'managed');
    assert.equal(separateDeploymentSession(directory), false);
    const session = {
      endpoint,
      environmentId: environment.environmentId,
      tokens: {
        access_token: 'deployment-token',
        token_type: 'Bearer',
        scope: 'orchestration:read orchestration:operate',
      },
      expiresAt: '2026-11-16T00:00:00.000Z',
    };
    saveCredential(t3AuthFile(directory), session);
    assert.equal(separateDeploymentSession(directory), true);
    assert.equal(existsSync(t3AuthFile(directory)), false);
    const moved = loadCredential(t3DeploymentFile(directory), endpoint);
    assert.equal(moved.tokens.access_token, 'deployment-token');
    assert.equal(statSync(t3DeploymentFile(directory)).mode & 0o777, 0o600);

    saveCredential(t3AuthFile(directory), {
      ...session,
      client: { client_id: 'person-client' },
    });
    assert.equal(separateDeploymentSession(directory), false);
    assert.equal(existsSync(t3AuthFile(directory)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
