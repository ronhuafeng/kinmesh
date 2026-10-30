import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { agentFixture, profileInput } from './agent-helpers.js';
import { fixture } from './helpers.js';
import { mockNativeServer } from './native-helpers.js';
import { reference } from './t3-helpers.js';
import { saveCredential } from '../src/adapters/t3/oauth.js';
import { readNativeExecution } from '../src/workspace/native.js';
import { NativeObservation } from '../src/workspace/contracts.js';

await test('native HTTP: missing optional configuration is 503 without expiring owner; exact owner scope precedes availability', async () => {
  const f = await agentFixture();
  try {
    const execution = await f.execution();
    const url = f.path + '/executions/' + execution.id + '/native';
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    assert.equal(
      (await f.app.inject({ url, headers: f.headers })).statusCode,
      403,
    );
    const response = await f.app.inject({ url, cookies: f.cookies });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      error: 'Native T3 status unavailable',
    });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.cookies.length, 0);
    assert.equal(
      (await f.app.inject({ url: '/api/me', cookies: f.cookies })).statusCode,
      200,
    );
    const other = f.store.agents.create(f.principal, f.teamId, {
      ...profileInput,
      name: 'Other native observer',
    });
    for (const [target, status] of [
      [url.replace(f.teamId, randomUUID()), 403],
      [url.replace(f.agent.id, randomUUID()), 404],
      [url.replace(f.agent.id, other.id), 404],
      [url.replace(execution.id, randomUUID()), 404],
      [url.replace(execution.id, 'invalid'), 400],
      [url + '?endpoint=https://evil.invalid/mcp', 400],
      [url + '?environmentId=other', 400],
    ] as const)
      assert.equal(
        (await f.app.inject({ url: target, cookies: f.cookies })).statusCode,
        status,
      );
    assert.deepEqual(
      f.store.agents.getCorrelation(
        f.principal,
        f.teamId,
        f.agent.id,
        execution.id,
      ),
      execution,
    );
    assert.throws(() =>
      f.store.agents.getCorrelation(
        f.store.agents.resolveToken(f.grant.token),
        f.teamId,
        f.agent.id,
        execution.id,
      ),
    );
    const raw = new Database(f.dbPath);
    raw
      .prepare("UPDATE memberships SET role = 'member' WHERE human_id = ?")
      .run(f.owner.id);
    raw.close();
    assert.equal(
      (await f.app.inject({ url, cookies: f.cookies })).statusCode,
      403,
    );
  } finally {
    await f.dispose();
  }
});

await test('MOCK HTTP: private credential/issuer/environment failures return generic 503 before any external request', async () => {
  const mock = await mockNativeServer();
  const files = fixture();
  const authFile = join(files.directory, 'MOCK-observer.json');
  const f = await agentFixture({
    nativeT3: { endpoint: mock.endpoint, authFile },
  });
  try {
    const execution = await f.execution();
    const url = f.path + '/executions/' + execution.id + '/native';
    const expectUnavailable = async () => {
      const response = await f.app.inject({ url, cookies: f.cookies });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        error: 'Native T3 status unavailable',
      });
      assert.doesNotMatch(
        response.body,
        /MOCK-unit-token|observer.json|access_token|client_id/,
      );
      assert.equal(
        (await f.app.inject({ url: '/api/me', cookies: f.cookies })).statusCode,
        200,
      );
    };
    await expectUnavailable(); // Missing file.
    writeFileSync(authFile, '{invalid MOCK credential}', { mode: 0o600 });
    await expectUnavailable();
    saveCredential(authFile, mock.credential);
    chmodSync(authFile, 0o644);
    await expectUnavailable();
    chmodSync(authFile, 0o600);
    saveCredential(authFile, {
      ...mock.credential,
      endpoint: 'https://wrong-issuer.invalid/mcp',
    });
    await expectUnavailable();
    saveCredential(authFile, mock.credential); // Valid file, wrong persisted environment.
    await expectUnavailable();
    assert.equal(mock.requests.length, 0);
  } finally {
    await f.dispose();
    files.cleanup();
    await mock.close();
  }
});

await test('MOCK SDK/HTTP: official protocol reads only two tools, validates returned link and hides upstream auth/status errors', async () => {
  const mock = await mockNativeServer();
  const files = fixture();
  const authFile = join(files.directory, 'MOCK-observer.json');
  saveCredential(authFile, mock.credential);
  const f = await agentFixture({
    nativeT3: { endpoint: mock.endpoint, authFile },
  });
  try {
    const execution = f.store.agents.correlate(
      f.principal,
      f.teamId,
      f.agent.id,
      { reference, providerSessionId: null, invocationId: null },
    );
    const url = f.path + '/executions/' + execution.id + '/native';
    const result = await f.app.inject({ url, cookies: f.cookies });
    assert.equal(result.statusCode, 200, result.body);
    const observation = NativeObservation.parse(result.json<unknown>());
    assert.equal(observation.status, 'completed');
    assert.equal(
      observation.verifiedUrl,
      `${mock.origin}/${reference.environmentId}/${reference.threadId}`,
    );
    assert.ok(mock.calls.length > 0);
    assert.ok(
      mock.calls.every((call) =>
        ['t3_environment_read', 't3_thread_read'].includes(call.name),
      ),
    );
    assert.deepEqual(
      mock.calls
        .filter((call) => call.name === 't3_thread_read')
        .map((call) => call.args),
      [
        {
          threadId: reference.threadId,
          view: 'messages',
          limit: 1,
          runLimit: 50,
          maxCharsPerItem: 1,
        },
      ],
    );
    assert.ok(mock.requests.every((request) => request.path === '/mcp'));
    assert.ok(
      mock.requests.every(
        (request) =>
          request.authorization ===
          'Bearer ' + mock.credential.tokens.access_token,
      ),
    );
    assert.doesNotMatch(result.body, /access_token|MOCK-unit-token|client_id/);
    for (const mode of [
      'unauthorized',
      'forbidden',
      'redirect',
      'wrong-environment',
      'bad-read',
    ] as const) {
      mock.mode.value = mode;
      const response = await f.app.inject({ url, cookies: f.cookies });
      assert.equal(response.statusCode, 503, mode + response.body);
      assert.deepEqual(response.json(), {
        error: 'Native T3 status unavailable',
      });
      assert.equal(
        (await f.app.inject({ url: '/api/me', cookies: f.cookies })).statusCode,
        200,
      );
    }
    assert.ok(mock.requests.every((request) => request.path === '/mcp')); // No redirects/discovery.
    const workspace = await f.app.inject({
      url: '/api/workspace',
      cookies: f.cookies,
    });
    assert.equal(
      workspace.json<{ nativeT3Origin: string }>().nativeT3Origin,
      mock.origin,
    );
    mock.mode.value = 'normal';
    mock.hooks.beforeThreadRead = () => {
      const raw = new Database(f.dbPath);
      try {
        raw
          .prepare("UPDATE memberships SET role = 'member' WHERE human_id = ?")
          .run(f.owner.id);
      } finally {
        raw.close();
      }
    };
    for (const mode of ['normal', 'bad-read'] as const) {
      const raw = new Database(f.dbPath);
      try {
        raw
          .prepare("UPDATE memberships SET role = 'owner' WHERE human_id = ?")
          .run(f.owner.id);
      } finally {
        raw.close();
      }
      mock.mode.value = mode;
      assert.equal(
        (await f.app.inject({ url, cookies: f.cookies })).statusCode,
        403,
      );
    }
  } finally {
    await f.dispose();
    files.cleanup();
    await mock.close();
  }
});

await test('MOCK SDK: total native deadline covers stalled MCP initialization', async () => {
  const mock = await mockNativeServer();
  try {
    mock.mode.value = 'hang';
    const start = Date.now();
    await assert.rejects(
      readNativeExecution(mock.credential, reference, AbortSignal.timeout(100)),
    );
    assert.ok(Date.now() - start < 3000);
    assert.equal(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});
