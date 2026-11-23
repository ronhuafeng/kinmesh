import { test } from 'node:test';
import { storeEnv } from './database.js';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/server/config.js';
import { feishuEnv, fixture } from './helpers.js';
import { signInAs, standInFeishu } from './feishu.js';

await test('configuration rejects absent secrets, invalid ports and non-loopback plaintext origins', () => {
  assert.throws(() => loadConfig({}));
  const env = {
    KINMESH_SESSION_KEY: 'b'.repeat(64),
    KINMESH_DATABASE_URL: 'postgres://kinmesh@127.0.0.1:5432/kinmesh',
    ...feishuEnv,
    ...storeEnv(),
  };
  // Without a PostgreSQL database there is nowhere to keep the team.
  for (const url of [
    '',
    'sqlite:.store/kinmesh.sqlite',
    '.store/kinmesh.sqlite',
  ])
    assert.throws(() => loadConfig({ ...env, KINMESH_DATABASE_URL: url }));
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
  // The commit the hub was built from: a full commit id, or unknown.
  const commit = 'a'.repeat(40);
  assert.equal(loadConfig(env).version, null);
  assert.equal(loadConfig({ ...env, KINMESH_VERSION: '' }).version, null);
  assert.equal(loadConfig({ ...env, KINMESH_VERSION: commit }).version, commit);
  for (const version of ['abc1234', 'latest', 'A'.repeat(40)])
    assert.throws(() => loadConfig({ ...env, KINMESH_VERSION: version }));
  // The space's provisioner and its token come together, or not at all.
  assert.equal(loadConfig(env).space, null);
  const space = {
    KINMESH_SPACE_ENDPOINT: 'http://t3-space:3774',
    KINMESH_SPACE_TOKEN_FILE: '/run/t3-space/token',
  };
  assert.deepEqual(loadConfig({ ...env, ...space }).space, {
    endpoint: space.KINMESH_SPACE_ENDPOINT,
    tokenFile: space.KINMESH_SPACE_TOKEN_FILE,
  });
  for (const [name, value] of Object.entries(space))
    assert.throws(() => loadConfig({ ...env, [name]: value }));
  assert.throws(() =>
    loadConfig({ ...env, ...space, KINMESH_SPACE_ENDPOINT: 'ftp://t3-space' }),
  );
  assert.throws(() => loadConfig({ ...env, KINMESH_PORT: '0' }));
  assert.throws(() =>
    loadConfig({ ...env, KINMESH_ORIGIN: 'http://remote.test' }),
  );
  assert.throws(() =>
    loadConfig({ ...env, KINMESH_ORIGIN: 'https://remote.test/path' }),
  );
  // A public HTTPS origin sits behind a proxy, which must be named.
  const team = {
    ...env,
    KINMESH_ORIGIN: 'https://remote.test',
    KINMESH_TRUSTED_PROXIES: '127.0.0.1, ::1, 10.0.0.0/8',
  };
  assert.equal(loadConfig(team).secureCookie, true);
  assert.deepEqual(loadConfig(team).trustedProxies, [
    '127.0.0.1',
    '::1',
    '10.0.0.0/8',
  ]);
  assert.throws(() =>
    loadConfig({ ...env, KINMESH_ORIGIN: 'https://remote.test' }),
  );
  for (const bad of ['proxy.example', '10.0.0.0/33', '::1/129', '1.2.3.4/8/1'])
    assert.throws(
      () => loadConfig({ ...team, KINMESH_TRUSTED_PROXIES: bad }),
      bad,
    );
  assert.deepEqual(loadConfig(env).trustedProxies, []);
  // The listener is loopback unless a container publishes it.
  assert.equal(loadConfig(env).host, '127.0.0.1');
  assert.equal(loadConfig({ ...env, KINMESH_HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.throws(() => loadConfig({ ...env, KINMESH_HOST: 'localhost' }));
  assert.equal(loadConfig(env).secureCookie, false);
  assert.equal(loadConfig(env).rateLimit, 300);
  assert.equal(
    loadConfig({ ...env, KINMESH_RATE_LIMIT: '600' }).rateLimit,
    600,
  );
  assert.throws(() => loadConfig({ ...env, KINMESH_RATE_LIMIT: '0' }));
});

await test('the workspace says where Team MCP is: its origin, the local default, or nowhere', () => {
  const env = {
    KINMESH_SESSION_KEY: 'b'.repeat(64),
    KINMESH_DATABASE_URL: 'postgres://kinmesh@127.0.0.1:5432/kinmesh',
    ...feishuEnv,
    ...storeEnv(),
  };
  assert.equal(loadConfig(env).teamMcpUrl, 'http://127.0.0.1:3001/mcp');
  const deployed = {
    ...env,
    KINMESH_ORIGIN: 'https://kinmesh.example.com',
    KINMESH_TRUSTED_PROXIES: '127.0.0.1',
  };
  // A deployment without Team MCP offers no token for it.
  assert.equal(loadConfig(deployed).teamMcpUrl, null);
  assert.equal(
    loadConfig({ ...deployed, KINMESH_TEAM_MCP_ORIGIN: 'https://team.example' })
      .teamMcpUrl,
    'https://team.example/mcp',
  );
});
await test('new session key rejects existing encrypted session', async () => {
  const { createApp } = await import('../src/server/app.js');
  const f = await fixture();
  let store = await f.open();
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
    store = await f.open();
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
    await f.cleanup();
  }
});
