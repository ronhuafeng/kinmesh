import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentFixture } from './agent-helpers.js';

type Fixture = Awaited<ReturnType<typeof agentFixture>>;
const OLD = 'a long owner test password';
const NEW = 'another long owner password';
async function login(f: Fixture, password: string) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'owner', password },
  });
  const cookie = response.cookies[0];
  return response.statusCode === 200 && cookie
    ? { [cookie.name]: cookie.value }
    : null;
}
const me = (f: Fixture, cookies: Record<string, string>) =>
  f.app.inject({ url: '/api/me', cookies });

await test('changing the password keeps this session and ends every other one', async () => {
  const f = await agentFixture();
  try {
    const other = await login(f, OLD);
    assert.ok(other);
    const change = (currentPassword: string, newPassword: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/me/password',
        cookies: f.cookies,
        payload: { currentPassword, newPassword },
      });
    assert.equal(
      (await change('not the current password', NEW)).statusCode,
      403,
    );
    assert.equal((await change(OLD, 'too short')).statusCode, 400);
    const changed = await change(OLD, NEW);
    assert.equal(changed.statusCode, 204);
    const cookie = changed.cookies[0];
    assert.ok(cookie);
    // This browser stays signed in with its re-issued session.
    assert.equal(
      (await me(f, { [cookie.name]: cookie.value })).statusCode,
      200,
    );
    // The old cookie of this browser and every other session are over.
    assert.equal((await me(f, f.cookies)).statusCode, 401);
    assert.equal((await me(f, other)).statusCode, 401);
    assert.equal(await login(f, OLD), null);
    assert.ok(await login(f, NEW));
    // An agent credential can never change a human's password.
    const agent = await f.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: f.headers,
      payload: { currentPassword: NEW, newPassword: OLD + ' again' },
    });
    assert.notEqual(agent.statusCode, 204);
    assert.ok(await login(f, NEW));
  } finally {
    await f.dispose();
  }
});

await test('the owner renames the team', async () => {
  const f = await agentFixture();
  try {
    const rename = (name: string) =>
      f.app.inject({
        method: 'PUT',
        url: '/api/team',
        cookies: f.cookies,
        payload: { name },
      });
    assert.equal((await rename('   ')).statusCode, 400);
    const renamed = await rename('  Fieldnotes  ');
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json<{ name: string }>().name, 'Fieldnotes');
    const team = await f.app.inject({ url: '/api/team', cookies: f.cookies });
    assert.match(team.body, /"name":"Fieldnotes"/);
    // Agents have no say over the team.
    const agent = await f.app.inject({
      method: 'PUT',
      url: '/api/team',
      headers: f.headers,
      payload: { name: 'Taken' },
    });
    assert.notEqual(agent.statusCode, 200);
  } finally {
    await f.dispose();
  }
});
