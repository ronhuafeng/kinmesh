import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/server/config.js';
import { feishuEnv, fixture } from './helpers.js';
import { signInAs, standInFeishu } from './feishu.js';

await test('configuration rejects absent secrets, invalid ports and non-loopback plaintext origins', () => {
  assert.throws(() => loadConfig({}));
  const env = { KINMESH_SESSION_KEY: 'b'.repeat(64), ...feishuEnv };
  // Without the Feishu app or the organization's domain, nobody could sign in.
  for (const key of Object.keys(feishuEnv))
    assert.throws(() => loadConfig({ ...env, [key]: '' }));
  assert.throws(() =>
    loadConfig({ ...env, KINMESH_EMAIL_DOMAIN: '@example.com' }),
  );
  assert.equal(
    loadConfig({ ...env, KINMESH_EMAIL_DOMAIN: ' Example.COM ' }).feishu
      .emailDomain,
    'example.com',
  );
  assert.equal(loadConfig(env).feishu.standIn, null);
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
  assert.equal(loadConfig(env).rateLimit, 60);
  assert.equal(
    loadConfig({ ...env, KINMESH_RATE_LIMIT: '600' }).rateLimit,
    600,
  );
  assert.throws(() => loadConfig({ ...env, KINMESH_RATE_LIMIT: '0' }));
});
await test('new session key rejects existing encrypted session', async () => {
  const { createApp } = await import('../src/server/app.js');
  const f = fixture();
  let store = f.open();
  let app = await createApp(
    f.config,
    store,
    undefined,
    undefined,
    {},
    {
      feishu: standInFeishu,
    },
  );
  try {
    const cookies = await signInAs(app, 'owner@example.com');
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
          cookies,
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
