import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TopicId } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import {
  communicationFixture,
  key,
  postInput,
} from './communication-helpers.js';

await test('a channel shows its ten most recently active topics first', async () => {
  const f = await communicationFixture();
  try {
    const ids: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const created = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/topics',
        cookies: f.cookies,
        payload: { operationKey: key(), title: 'Topic ' + String(i) },
      });
      assert.equal(created.statusCode, 201);
      ids.push(created.json<{ id: string }>().id);
    }
    const active = async () =>
      WorkspaceSnapshot.parse(
        (
          await f.app.inject({ url: '/api/workspace', cookies: f.cookies })
        ).json<unknown>(),
      ).activeTopics;

    // Untouched, the newest come first; the oldest two are left for "more".
    const before = await active();
    assert.equal(before.items.length, 10);
    assert.equal(before.more, true);
    assert.equal(before.items[0]?.title, 'Topic 12');
    assert.ok(!before.items.some((t) => t.title === 'Topic 1'));

    // A message in the oldest topic makes it the most recent.
    const posted = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: postInput({
        topicId: TopicId.parse(ids[0]),
        body: 'Back to this',
      }),
    });
    assert.equal(posted.statusCode, 201);
    const after = await active();
    assert.equal(after.items[0]?.title, 'Topic 1');
    assert.equal(after.items.length, 10);
  } finally {
    await f.dispose();
  }
});
