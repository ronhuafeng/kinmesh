import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS_FIRST, TopicId } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import {
  communicationFixture,
  key,
  postInput,
} from './communication-helpers.js';

/**
 * Proves a channel lists its topics as one list, the most recently active
 * first: a newer topic leads it, the first page reaches only so far, asking
 * for more widens the same list keeping what it showed, a message brings a
 * topic to the top, and the topic you are in is always named.
 */
await test('a channel lists its topics most recently active first, and more widens the same list', async () => {
  const f = await communicationFixture();
  try {
    const ids: string[] = [];
    for (let i = 1; i <= TOPICS_FIRST + 2; i++) {
      const created = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/topics',
        cookies: f.cookies,
        payload: { operationKey: key(), title: 'Topic ' + String(i) },
      });
      assert.equal(created.statusCode, 201);
      ids.push(created.json<{ id: string }>().id);
    }
    const read = async (query = '') =>
      WorkspaceSnapshot.parse(
        (
          await f.app.inject({
            url: '/api/workspace?channelId=' + f.channelId + query,
            cookies: f.cookies,
          })
        ).json<unknown>(),
      );

    // Untouched, the newest come first; the oldest two wait for more.
    const first = (await read()).topics;
    assert.equal(first.items.length, TOPICS_FIRST);
    assert.equal(first.more, true);
    assert.equal(first.items[0]?.title, 'Topic ' + String(TOPICS_FIRST + 2));
    assert.ok(!first.items.some((t) => t.title === 'Topic 1'));
    // More widens the same list: what it showed stays, in the same order.
    const wider = (await read('&topicsShown=' + String(TOPICS_FIRST * 2)))
      .topics;
    assert.equal(wider.more, false);
    assert.deepEqual(
      wider.items.slice(0, TOPICS_FIRST).map((t) => t.id),
      first.items.map((t) => t.id),
    );
    assert.equal(wider.items.at(-1)?.title, 'Topic 1');

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
    assert.equal((await read()).topics.items[0]?.title, 'Topic 1');

    // The topic you are in is named, though the list doesn't reach it.
    const open = TopicId.parse(ids[1]);
    const inIt = await read('&topicId=' + open);
    assert.ok(!inIt.topics.items.some((t) => t.id === open));
    assert.equal(inIt.namedTopics.find((t) => t.id === open)?.title, 'Topic 2');
  } finally {
    await f.dispose();
  }
});
