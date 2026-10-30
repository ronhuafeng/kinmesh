import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { fixture } from './helpers.js';

const input = {
  username: 'owner',
  password: 'a long test password 123',
  teamName: 'My team',
};
await test('first-run setup requires secret, is one-time, validates input and authenticates real owner', async () => {
  const f = fixture();
  const store = f.open();
  const app = await createApp(f.config, store);
  try {
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/team' })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/setup', payload: input }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup',
          headers: { authorization: 'Bearer wrong' },
          payload: input,
        })
      ).statusCode,
      401,
    );
    const headers = { authorization: `Bearer ${f.config.setupToken}` };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup',
          headers,
          payload: { ...input, unexpected: true },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup',
          headers,
          payload: input,
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup',
          headers,
          payload: input,
        })
      ).statusCode,
      409,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: input.username, password: input.password },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies[0];
    assert.ok(cookie);
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
    const cookies = { [cookie.name]: cookie.value };
    const me = await app.inject({ url: '/api/me', cookies });
    assert.equal(me.statusCode, 200);
    assert.equal(
      z
        .object({ human: z.object({ username: z.string() }) })
        .parse(me.json<unknown>()).human.username,
      input.username,
    );
    const team = await app.inject({ url: '/api/team', cookies });
    assert.equal(team.statusCode, 200);
    assert.ok(!team.body.includes('password'));
    assert.equal(
      (
        await app.inject({
          url: '/api/team',
          headers: { 'x-actor-id': 'owner' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/team',
          cookies,
          headers: { 'x-member-id': 'someone' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/me',
          cookies: { [cookie.name]: cookie.value + 'tampered' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/logout',
          cookies,
          headers: { origin: 'https://attacker.test' },
        })
      ).statusCode,
      403,
    );
    const logout = await app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies,
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(logout.cookies[0]?.value, '');
  } finally {
    await app.close();
    store.close();
    f.cleanup();
  }
});
await test('login rejects invalid, unknown and incorrect credentials; rate limit bounds attempts', async () => {
  const f = fixture();
  const store = f.open();
  const app = await createApp(f.config, store);
  try {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/login', payload: {} }))
        .statusCode,
      400,
    );
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'missing', password: input.password },
      });
      assert.equal(r.statusCode, 401);
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/login', payload: input }))
        .statusCode,
      429,
    );
  } finally {
    await app.close();
    store.close();
    f.cleanup();
  }
});
await test('service restart preserves owner, team and encrypted session with same key', async () => {
  const f = fixture();
  let store = f.open();
  let app = await createApp(f.config, store);
  try {
    await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { authorization: `Bearer ${f.config.setupToken}` },
      payload: input,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: input.username, password: input.password },
    });
    const cookie = login.cookies[0];
    assert.ok(cookie);
    await app.close();
    store.close();
    store = f.open();
    app = await createApp(f.config, store);
    assert.equal(
      (
        await app.inject({
          url: '/api/team',
          cookies: { [cookie.name]: cookie.value },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/setup',
          headers: { authorization: `Bearer ${f.config.setupToken}` },
          payload: input,
        })
      ).statusCode,
      409,
    );
    assert.equal(store.isBootstrapped(), true);
  } finally {
    await app.close();
    store.close();
    f.cleanup();
  }
});

await test('concurrent setup requests produce exactly one owner and no partial competing team', async () => {
  const f = fixture();
  const store = f.open();
  const app = await createApp(f.config, store);
  try {
    const results = await Promise.all(
      ['first', 'second'].map((username) =>
        app.inject({
          method: 'POST',
          url: '/api/setup',
          headers: { authorization: `Bearer ${f.config.setupToken}` },
          payload: { ...input, username },
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
    assert.equal(
      ['first', 'second'].filter(
        (name) => store.credentials(name) !== undefined,
      ).length,
      1,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
await test('incorrect owner password fails and stored hash is Argon2, not plaintext', async () => {
  const f = fixture();
  const store = f.open();
  const app = await createApp(f.config, store);
  try {
    await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { authorization: `Bearer ${f.config.setupToken}` },
      payload: input,
    });
    const account = store.credentials(input.username);
    assert.ok(account);
    assert.match(account.passwordHash, /^\$argon2id\$/);
    assert.ok(!account.passwordHash.includes(input.password));
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          payload: {
            username: input.username,
            password: 'incorrect password 12345',
          },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { origin: 'https://evil.test' },
          payload: { username: input.username, password: input.password },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
await test('health becomes unavailable when persistence cannot be queried', async () => {
  const f = fixture();
  const store = f.open();
  const app = await createApp(f.config, store);
  try {
    store.close();
    assert.equal((await app.inject({ url: '/health' })).statusCode, 503);
  } finally {
    await app.close();
    f.cleanup();
  }
});

await test('reads reject missing membership and deleted account instead of trusting session identity alone', async () => {
  const { default: Database } = await import('better-sqlite3');
  const f = fixture();
  const store = f.open();
  const app = await createApp(f.config, store);
  try {
    await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { authorization: `Bearer ${f.config.setupToken}` },
      payload: input,
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: input.username, password: input.password },
    });
    const cookie = login.cookies[0];
    assert.ok(cookie);
    const cookies = { [cookie.name]: cookie.value };
    const raw = new Database(f.path);
    raw.pragma('foreign_keys = ON');
    try {
      raw.exec('DELETE FROM memberships');
      assert.equal(
        (await app.inject({ url: '/api/team', cookies })).statusCode,
        403,
      );
      raw.exec('DELETE FROM humans');
      assert.equal(
        (await app.inject({ url: '/api/me', cookies })).statusCode,
        401,
      );
      assert.equal(
        (await app.inject({ url: '/api/team', cookies })).statusCode,
        401,
      );
    } finally {
      raw.close();
    }
  } finally {
    await app.close();
    f.cleanup();
  }
});
await test('request limits and schema errors do not echo submitted secrets', async () => {
  const f = fixture();
  const store = f.open();
  const app = await createApp(f.config, store);
  try {
    const secret = 'validation-sensitive-canary';
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: secret },
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(!invalid.body.includes(secret));
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'owner', password: secret.repeat(1000) },
    });
    assert.equal(oversized.statusCode, 413);
    assert.ok(!oversized.body.includes(secret));
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/logout' })).statusCode,
      401,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
