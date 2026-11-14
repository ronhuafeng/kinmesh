import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { fixture } from './helpers.js';
import { signInAs, standInFeishu } from './feishu.js';

const hub = (f: ReturnType<typeof fixture>, config = f.config) =>
  createApp(
    config,
    f.open(),
    undefined,
    undefined,
    {},
    {
      feishu: standInFeishu,
    },
  );
await test('a signed-in person holds a strict, HTTP-only session that only this origin may use', async () => {
  const f = fixture();
  const app = await hub(f);
  try {
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/team' })).statusCode, 401);
    const begin = await app.inject({ url: '/login' });
    const state = new URL(String(begin.headers.location)).searchParams.get(
      'state',
    );
    const login = begin.cookies.find((c) => c.name === 'kinmesh-login');
    assert.ok(state && login);
    const back = await app.inject({
      url: `/login/callback?code=owner%40example.com&state=${state}`,
      cookies: { [login.name]: login.value },
    });
    const cookie = back.cookies.find((c) => c.name === 'kinmesh-session');
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Strict');
    // The sign-in's own cookie is spent.
    assert.equal(
      back.cookies.find((c) => c.name === 'kinmesh-login')?.value,
      '',
    );
    const cookies = { [cookie.name]: cookie.value };
    const me = await app.inject({ url: '/api/me', cookies });
    assert.equal(me.statusCode, 200);
    assert.equal(
      z
        .object({ human: z.object({ username: z.string() }) })
        .parse(me.json<unknown>()).human.username,
      'owner',
    );
    const team = await app.inject({ url: '/api/team', cookies });
    assert.equal(team.statusCode, 200);
    assert.ok(!team.body.includes('example.com'));
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
    f.cleanup();
  }
});
await test('the overall rate limit bounds every client, at the configured pace', async () => {
  const f = fixture();
  const app = await hub(f, { ...f.config, rateLimit: 3 });
  try {
    for (let i = 0; i < 3; i++)
      assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/health' })).statusCode, 429);
  } finally {
    await app.close();
    f.cleanup();
  }
});
await test('sign-in attempts are bounded per minute', async () => {
  const f = fixture();
  const app = await hub(f);
  try {
    for (let i = 0; i < 10; i++)
      assert.equal((await app.inject({ url: '/login' })).statusCode, 302);
    assert.equal((await app.inject({ url: '/login' })).statusCode, 429);
  } finally {
    await app.close();
    f.cleanup();
  }
});
await test('service restart preserves the person, the team and the session with the same key', async () => {
  const f = fixture();
  let app = await hub(f);
  try {
    const cookies = await signInAs(app, 'owner@example.com');
    await app.close();
    app = await hub(f);
    assert.equal(
      (await app.inject({ url: '/api/team', cookies })).statusCode,
      200,
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
    await store.close();
    assert.equal((await app.inject({ url: '/health' })).statusCode, 503);
  } finally {
    await app.close();
    f.cleanup();
  }
});

await test('reads reject missing membership and deleted account instead of trusting session identity alone', async () => {
  const { default: Database } = await import('better-sqlite3');
  const f = fixture();
  const app = await hub(f);
  try {
    const cookies = await signInAs(app, 'owner@example.com');
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
  const app = await hub(f);
  try {
    const cookies = await signInAs(app, 'owner@example.com');
    const secret = 'validation-sensitive-canary';
    const { team } = (await app.inject({ url: '/api/team', cookies })).json<{
      team: { id: string };
    }>();
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/teams/${team.id}/channels`,
      cookies,
      payload: { name: secret, unexpected: secret },
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(!invalid.body.includes(secret));
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies,
      payload: { name: secret.repeat(1000) },
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
