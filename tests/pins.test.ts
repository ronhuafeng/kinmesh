import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { communicationFixture, postInput } from './communication-helpers.js';

const Pins = z.array(
  z.object({ message: z.object({ id: z.string() }), pinnedBy: z.string() }),
);

/**
 * Proves a person pins a message in its channel and unpins it, pins show the
 * latest first in the workspace, and agents can't pin.
 */
await test('a person pins messages in a channel and unpins them; the workspace shows them', async () => {
  const f = await communicationFixture();
  try {
    const post = async (body: string) => {
      const posted = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        cookies: f.cookies,
        payload: postInput({ body }),
      });
      assert.equal(posted.statusCode, 201);
      return posted.json<{ id: string }>().id;
    };
    const first = await post('The decision');
    const second = await post('The plan');
    const pin = (id: string, on: boolean, headers?: Record<string, string>) =>
      f.app.inject({
        method: 'POST',
        url: `${f.channelPath}/messages/${id}/pin`,
        ...(headers ? { headers } : { cookies: f.cookies }),
        payload: { on },
      });
    assert.equal((await pin(first, true)).statusCode, 200);
    const both = Pins.parse((await pin(second, true)).json());
    // The latest pinned first, by whom.
    assert.deepEqual(
      both.map((p) => p.message.id),
      [second, first],
    );
    assert.equal(both[0]?.pinnedBy, f.owner.id);
    // Pinning again changes nothing; agents can't pin.
    assert.equal(Pins.parse((await pin(first, true)).json()).length, 2);
    assert.equal((await pin(first, true, f.headers)).statusCode, 403);
    assert.deepEqual(
      Pins.parse((await pin(second, false)).json()).map((p) => p.message.id),
      [first],
    );
    const snapshot = await f.app.inject({
      method: 'GET',
      url: '/api/workspace?channelId=' + f.channelId,
      cookies: f.cookies,
    });
    assert.deepEqual(
      Pins.parse(snapshot.json<{ pinned: unknown }>().pinned).map(
        (p) => p.message.id,
      ),
      [first],
    );
  } finally {
    await f.dispose();
  }
});
