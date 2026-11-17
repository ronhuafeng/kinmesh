import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import {
  communicationFixture,
  key,
  postInput,
} from './communication-helpers.js';

await test('the workspace carries each listed channel’s newest message, and no channel without one', async () => {
  const f = await communicationFixture();
  try {
    const latest = async () =>
      WorkspaceSnapshot.parse(
        (
          await f.app.inject({ url: '/api/workspace', cookies: f.cookies })
        ).json<unknown>(),
      ).latest;
    // A channel nobody has written in has nothing to show.
    const quiet = await f.app.inject({
      method: 'POST',
      url: f.channelsPath,
      cookies: f.cookies,
      payload: { operationKey: key(), name: 'quiet' },
    });
    assert.equal(quiet.statusCode, 201);
    const quietId = quiet.json<{ id: string }>().id;
    assert.ok(!(await latest()).some((l) => l.channelId === quietId));

    // The newest of several messages is the one carried, cut to 200
    // characters, with its author and time.
    for (const body of ['First', 'Second', 'x'.repeat(300)]) {
      const posted = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        cookies: f.cookies,
        payload: postInput({ body }),
      });
      assert.equal(posted.statusCode, 201);
    }
    const general = (await latest()).find((l) => l.channelId === f.channelId);
    assert.equal(general?.excerpt, 'x'.repeat(200));
    assert.deepEqual(general.author, { kind: 'human', humanId: f.owner.id });
    assert.ok(Date.parse(general.createdAt) <= Date.now());

    // A channel left is not listed, so neither is its message.
    const left = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/leave',
      cookies: f.cookies,
      payload: { operationKey: key() },
    });
    assert.equal(left.statusCode, 200);
    assert.ok(!(await latest()).some((l) => l.channelId === f.channelId));
  } finally {
    await f.dispose();
  }
});
