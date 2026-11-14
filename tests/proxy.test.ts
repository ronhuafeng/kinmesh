import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { fixture } from './helpers.js';
import { standInFeishu } from './feishu.js';

const PROXY = '10.0.0.1';
async function hub(trustedProxies: string[], rateLimit = 3) {
  const f = fixture();
  const app = await createApp(
    { ...f.config, rateLimit, trustedProxies },
    f.open(),
    undefined,
    undefined,
    {},
    { feishu: standInFeishu },
  );
  return {
    app,
    /** A request reaching the hub from `from`, saying it is for `client`. */
    from: (from: string, client: string, url = '/health') =>
      app.inject({
        url,
        remoteAddress: from,
        headers: { 'x-forwarded-for': client },
      }),
    async dispose() {
      await app.close();
      f.cleanup();
    },
  };
}

await test('behind a trusted proxy, each client has its own limits', async () => {
  const h = await hub([PROXY]);
  try {
    for (let i = 0; i < 3; i++)
      assert.equal((await h.from(PROXY, '203.0.113.1')).statusCode, 200);
    assert.equal((await h.from(PROXY, '203.0.113.1')).statusCode, 429);
    // Someone else behind the same proxy is not held back.
    assert.equal((await h.from(PROXY, '203.0.113.2')).statusCode, 200);
  } finally {
    await h.dispose();
  }
});

await test('a forwarding header from anyone but a trusted proxy is ignored', async () => {
  const h = await hub([PROXY]);
  try {
    // Claiming a new client each time does not escape the limit.
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await h.from('198.51.100.7', `203.0.113.${String(i)}`)).statusCode,
        200,
      );
    assert.equal(
      (await h.from('198.51.100.7', '203.0.113.99')).statusCode,
      429,
    );
  } finally {
    await h.dispose();
  }
});

await test('one client at the sign-in limit does not keep another from signing in', async () => {
  // The overall limit is high here, so only sign-in's own binds.
  const h = await hub([PROXY], 1000);
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await h.from(PROXY, '203.0.113.1', '/login')).statusCode,
        302,
      );
    assert.equal(
      (await h.from(PROXY, '203.0.113.1', '/login')).statusCode,
      429,
    );
    assert.equal(
      (await h.from(PROXY, '203.0.113.2', '/login')).statusCode,
      302,
    );
  } finally {
    await h.dispose();
  }
});
