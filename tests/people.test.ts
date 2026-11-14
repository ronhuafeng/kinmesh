import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/app.js';
import { PRESENCE_MS } from '../src/domain/contracts.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { fixture } from './helpers.js';
import { signInAs, standInFeishu } from './feishu.js';

await test('people of the team see each other: by name, in the channel, and who is online', async () => {
  const f = fixture();
  const store = f.open();
  const app = await createApp(
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
    const ada = await signInAs(app, 'ada@example.com');
    const grace = await signInAs(app, 'grace@example.com');
    const snapshot = async (cookies: Record<string, string>) =>
      WorkspaceSnapshot.parse(
        (await app.inject({ url: '/api/workspace', cookies })).json<unknown>(),
      );
    const seen = await snapshot(ada);
    assert.deepEqual(
      seen.people.map((p) => [p.username, p.online]),
      [
        ['ada', true],
        ['grace', true],
      ],
    );
    // Both are in #general, where the second joined on signing in.
    assert.equal(seen.channel?.name, 'general');
    assert.deepEqual(
      [...seen.joinedHumanIds].sort(),
      seen.people.map((p) => p.id).sort(),
    );
    // Grace sees the same people.
    assert.deepEqual(
      (await snapshot(grace)).people.map((p) => p.username),
      ['ada', 'grace'],
    );
    // Signed out, Grace is offline; quiet past the window, so is anyone.
    await app.inject({ method: 'POST', url: '/api/logout', cookies: grace });
    assert.deepEqual(
      (await snapshot(ada)).people.map((p) => [p.username, p.online]),
      [
        ['ada', true],
        ['grace', false],
      ],
    );
    const later = Date.now() + PRESENCE_MS + 1;
    assert.deepEqual(store.online(later), []);
  } finally {
    await app.close();
    f.cleanup();
  }
});
