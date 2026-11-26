import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { key, postInput } from './communication-helpers.js';
import { taskFixture } from './task-helpers.js';

/**
 * Proves a topic named on screen has its title however many topics came
 * before it: the topic page holds the channel's oldest, yet a task's topic
 * and a shown message's topic come with the workspace, and a topic nothing
 * names does not.
 */
await test('the topics a task or a shown message is in come with the workspace, beyond the topic page', async () => {
  const f = await taskFixture();
  try {
    const topic = (title: string) =>
      f.store.topics.createTopic(f.principal, f.teamId, f.channelId, {
        operationKey: key(),
        title,
      });
    for (let n = 0; n < 50; n++) await topic(`Early ${String(n)}`);
    const unnamed = await topic('Named by nothing');
    const ofTask = await topic('A task is here');
    const ofMessage = await topic('A message is here');
    await f.create({ title: 'In a late topic', topicId: ofTask.id });
    await f.store.messages.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ body: 'Late', topicId: ofMessage.id }),
    );

    const response = await f.app.inject({
      url: '/api/workspace?channelId=' + f.channelId,
      cookies: f.cookies,
    });
    const data = WorkspaceSnapshot.parse(response.json());
    const page = new Set(data.topics.items.map((t) => t.id));
    assert.ok(!page.has(ofTask.id) && !page.has(ofMessage.id));
    assert.deepEqual(
      data.namedTopics.map((t) => t.title),
      ['A message is here', 'A task is here'],
    );
    assert.ok(!data.namedTopics.some((t) => t.id === unnamed.id));
  } finally {
    await f.dispose();
  }
});
