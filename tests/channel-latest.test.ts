import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

await test('a channel is unread when someone else wrote after the person read it, and reading only moves forward', async () => {
  const f = await communicationFixture();
  try {
    await f.invite();
    const unread = async () =>
      WorkspaceSnapshot.parse(
        (
          await f.app.inject({ url: '/api/workspace', cookies: f.cookies })
        ).json<unknown>(),
      ).latest.find((l) => l.channelId === f.channelId)?.unread;
    const post = async (as: 'person' | 'agent', topicId: string | null) => {
      const posted = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        ...(as === 'person' ? { cookies: f.cookies } : { headers: f.headers }),
        payload: { ...postInput(), topicId },
      });
      assert.equal(posted.statusCode, 201);
      return posted.json<{ id: string }>().id;
    };
    const read = (messageId: string, topicId: string | null) =>
      f.app.inject({
        method: 'POST',
        url: f.channelPath + '/read',
        cookies: f.cookies,
        payload: { messageId, topicId },
      });

    // What you write yourself is never unread.
    await post('person', null);
    assert.equal(await unread(), false);

    // Someone else's message is, until you read it.
    const first = await post('agent', null);
    assert.equal(await unread(), true);
    assert.equal((await read(first, null)).statusCode, 204);
    assert.equal(await unread(), false);

    const topic = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/topics',
      cookies: f.cookies,
      payload: { operationKey: key(), title: 'Plans' },
    });
    assert.equal(topic.statusCode, 201);
    const topicId = topic.json<{ id: string }>().id;

    // Reading a topic leaves unread what came before it elsewhere.
    const outside = await post('agent', null);
    const inside = await post('agent', topicId);
    assert.equal((await read(inside, topicId)).statusCode, 204);
    assert.equal(await unread(), true);
    // Reading the whole channel reads it all.
    assert.equal((await read(inside, null)).statusCode, 204);
    assert.equal(await unread(), false);

    // What came after the topic's message elsewhere stays unread too.
    const later = await post('agent', topicId);
    const elsewhere = await post('agent', null);
    assert.equal((await read(later, topicId)).statusCode, 204);
    assert.equal(await unread(), true);
    assert.equal((await read(elsewhere, null)).statusCode, 204);
    assert.equal(await unread(), false);

    // Reading an older message never moves the position back.
    assert.equal((await read(outside, null)).statusCode, 204);
    assert.equal(await unread(), false);

    // A message of another topic, an unknown one, or an agent reading: refused.
    assert.equal((await read(elsewhere, topicId)).statusCode, 404);
    assert.equal((await read(randomUUID(), null)).statusCode, 404);
    const agentRead = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/read',
      headers: f.headers,
      payload: { messageId: elsewhere, topicId: null },
    });
    assert.equal(agentRead.statusCode, 403);
  } finally {
    await f.dispose();
  }
});
