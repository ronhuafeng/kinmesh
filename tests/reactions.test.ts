import { test } from 'node:test';
import assert from 'node:assert/strict';
import { communicationFixture, postInput } from './communication-helpers.js';

/**
 * Proves a reaction is a person's own, added once and taken back, from the
 * small fixed set, by people in the channel only, and that it wakes no agent
 * and notifies nobody.
 */
await test('a person reacts to a message and takes it back; nobody else is told', async () => {
  const f = await communicationFixture();
  try {
    await f.invite();
    const posted = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: postInput({ body: 'Ship it?' }),
    });
    assert.equal(posted.statusCode, 201);
    const messageId = posted.json<{ id: string }>().id;
    const react = (
      emoji: string,
      on: boolean,
      as: {
        cookies?: Record<string, string>;
        headers?: Record<string, string>;
      } = {
        cookies: f.cookies,
      },
    ) =>
      f.app.inject({
        method: 'POST',
        url: `${f.channelPath}/messages/${messageId}/reactions`,
        ...as,
        payload: { emoji, on },
      });
    const added = await react('👍', true);
    assert.equal(added.statusCode, 200);
    assert.deepEqual(added.json(), [
      { messageId, emoji: '👍', humanIds: [f.owner.id] },
    ]);
    // Doing what is done changes nothing.
    assert.deepEqual((await react('👍', true)).json(), added.json());
    assert.deepEqual((await react('👍', false)).json(), []);
    // Only the fixed set, and only people: an agent's token can't react.
    assert.equal((await react('🤖', true)).statusCode, 400);
    assert.equal(
      (await react('👍', true, { headers: f.headers })).statusCode,
      403,
    );
    // A reaction wakes no agent and makes no notification.
    await react('🎉', true);
    assert.deepEqual(await f.store.notifications.take(10), []);
    const snapshot = await f.app.inject({
      method: 'GET',
      url: '/api/workspace?channelId=' + f.channelId,
      cookies: f.cookies,
    });
    assert.deepEqual(snapshot.json<{ reactions: unknown }>().reactions, [
      { messageId, emoji: '🎉', humanIds: [f.owner.id] },
    ]);
  } finally {
    await f.dispose();
  }
});
