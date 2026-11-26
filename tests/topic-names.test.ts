import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPICS_FIRST } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { key, postInput } from './communication-helpers.js';
import { taskFixture } from './task-helpers.js';

/**
 * Proves a topic named on screen has its title however far the topic list
 * reaches: a task's topic and a shown message's topic come with the
 * workspace, and a topic nothing names does not.
 */
await test('the topics a task or a shown message is in come with the workspace, beyond the topic list', async () => {
  const f = await taskFixture();
  try {
    const topic = (title: string) =>
      f.store.topics.createTopic(f.principal, f.teamId, f.channelId, {
        operationKey: key(),
        title,
      });
    const unnamed = await topic('Named by nothing');
    const ofTask = await topic('A task is here');
    const ofMessage = await topic('A message is here');
    await f.create({ title: 'In an old topic', topicId: ofTask.id });
    await f.store.messages.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ body: 'Old', topicId: ofMessage.id }),
    );
    // Newer topics fill the list, so it no longer reaches those three.
    for (let n = 0; n < TOPICS_FIRST; n++) await topic(`Later ${String(n)}`);

    const response = await f.app.inject({
      url: '/api/workspace?channelId=' + f.channelId,
      cookies: f.cookies,
    });
    const data = WorkspaceSnapshot.parse(response.json());
    const listed = new Set(data.topics.items.map((t) => t.id));
    assert.ok(!listed.has(ofTask.id) && !listed.has(ofMessage.id));
    assert.deepEqual(
      data.namedTopics.map((t) => t.title),
      ['A message is here', 'A task is here'],
    );
    assert.ok(!data.namedTopics.some((t) => t.id === unnamed.id));
  } finally {
    await f.dispose();
  }
});
