import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/server/config.js';
import { fixture } from './helpers.js';

await test('configuration rejects absent secrets, invalid ports and non-loopback plaintext origins', () => {
  assert.throws(() => loadConfig({}));
  const env = {
    KINMESH_SETUP_TOKEN: 'a'.repeat(64),
    KINMESH_SESSION_KEY: 'b'.repeat(64),
  };
  assert.throws(() => loadConfig({ ...env, KINMESH_PORT: '0' }));
  assert.throws(() =>
    loadConfig({ ...env, KINMESH_ORIGIN: 'http://remote.test' }),
  );
  assert.throws(() =>
    loadConfig({ ...env, KINMESH_ORIGIN: 'https://remote.test/path' }),
  );
  assert.equal(
    loadConfig({ ...env, KINMESH_ORIGIN: 'https://remote.test' }).secureCookie,
    true,
  );
  assert.equal(loadConfig(env).secureCookie, false);
});
await test('new session key rejects existing encrypted session', async () => {
  const { createApp } = await import('../src/server/app.js');
  const f = fixture();
  let store = f.open();
  let app = await createApp(f.config, store);
  try {
    const payload = {
      username: 'owner',
      password: 'a unique test password 123',
      teamName: 'Team',
    };
    await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { authorization: `Bearer ${f.config.setupToken}` },
      payload,
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: payload.username, password: payload.password },
    });
    const cookie = result.cookies[0];
    assert.ok(cookie);
    await app.close();
    store = f.open();
    app = await createApp(
      { ...f.config, sessionKey: Buffer.alloc(32, 42) },
      store,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/me',
          cookies: { [cookie.name]: cookie.value },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});

await test('native observer configuration is optional, paired and strictly endpoint-validated', () => {
  const env = {
    KINMESH_SETUP_TOKEN: 'a'.repeat(64),
    KINMESH_SESSION_KEY: 'b'.repeat(64),
  };
  assert.equal(loadConfig(env).nativeT3, undefined);
  assert.throws(() =>
    loadConfig({ ...env, KINMESH_T3_ENDPOINT: 'https://t3.example/mcp' }),
  );
  assert.throws(() =>
    loadConfig({ ...env, KINMESH_T3_AUTH_FILE: '/private/observer.json' }),
  );
  for (const endpoint of [
    'http://remote.example/mcp',
    'https://user:secret@t3.example/mcp',
    'https://t3.example/wrong',
    'https://t3.example/mcp?secret=x',
    't3-thread://thread',
    'https://t3.example/mcp?',
    'https://t3.example/mcp#',
    ' https://t3.example/mcp',
  ])
    assert.throws(() =>
      loadConfig({
        ...env,
        KINMESH_T3_ENDPOINT: endpoint,
        KINMESH_T3_AUTH_FILE: '/private/observer.json',
      }),
    );
  assert.throws(() =>
    loadConfig({
      ...env,
      KINMESH_T3_ENDPOINT: 'https://t3.example/mcp',
      KINMESH_T3_AUTH_FILE: '',
    }),
  );
  assert.deepEqual(
    loadConfig({
      ...env,
      KINMESH_T3_ENDPOINT: 'https://t3.example/mcp',
      KINMESH_T3_AUTH_FILE: '/private/observer.json',
    }).nativeT3,
    { endpoint: 'https://t3.example/mcp', authFile: '/private/observer.json' },
  );
});
