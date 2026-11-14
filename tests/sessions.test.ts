import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
} from '../src/domain/contracts.js';
import { agentFixture } from './agent-helpers.js';
import { signInAs } from './feishu.js';

const MINUTE = 60 * 1000;

await test('a session ends when idle too long, and when too old even if used', async () => {
  const f = await agentFixture();
  try {
    const start = Date.now();
    const used = f.store.sessions.open(f.owner.id, start);
    // Used every 15 minutes, it lives past the idle limit...
    let now = start;
    while (now < start + SESSION_IDLE_MS * 2) {
      now += 15 * MINUTE;
      assert.equal(f.store.sessions.resolve(used, now), f.owner.id);
    }
    // ...but not past its lifetime.
    assert.equal(
      f.store.sessions.resolve(used, start + SESSION_LIFETIME_MS + 1),
      undefined,
    );
    // Left alone, it ends after the idle limit.
    const idle = f.store.sessions.open(f.owner.id, start);
    assert.equal(
      f.store.sessions.resolve(idle, start + SESSION_IDLE_MS - MINUTE),
      f.owner.id,
    );
    const later = start + SESSION_IDLE_MS - MINUTE;
    assert.equal(
      f.store.sessions.resolve(idle, later + SESSION_IDLE_MS + 1),
      undefined,
    );
    // Nothing that is not a live token resolves.
    for (const token of [undefined, '', 'not-a-session', 42])
      assert.equal(f.store.sessions.resolve(token, start), undefined);
  } finally {
    await f.dispose();
  }
});

await test('a revoked session is refused, even from a copied cookie', async () => {
  const f = await agentFixture();
  try {
    const me = (cookies: Record<string, string>) =>
      f.app.inject({ url: '/api/me', cookies });
    assert.equal((await me(f.cookies)).statusCode, 200);
    // A copy of the cookie is the same session.
    const copy = { ...f.cookies };
    const out = await f.app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies: f.cookies,
    });
    assert.equal(out.statusCode, 204);
    assert.equal((await me(copy)).statusCode, 401);
  } finally {
    await f.dispose();
  }
});

await test('signing out everywhere ends every session of yours', async () => {
  const f = await agentFixture();
  try {
    const other = await signInAs(f.app, 'owner@example.com');
    const me = (cookies: Record<string, string>) =>
      f.app.inject({ url: '/api/me', cookies });
    assert.equal((await me(other)).statusCode, 200);
    const end = await f.app.inject({
      method: 'POST',
      url: '/api/me/sessions/end',
      cookies: f.cookies,
    });
    assert.equal(end.statusCode, 204);
    assert.equal((await me(f.cookies)).statusCode, 401);
    assert.equal((await me(other)).statusCode, 401);
  } finally {
    await f.dispose();
  }
});
