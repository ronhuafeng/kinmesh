import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rawDatabase } from './raw.js';
import { z } from 'zod';
import {
  postInput,
  key,
  communicationFixture,
} from './communication-helpers.js';

await test('communication SQL constraints and immutable facts prevent cross-channel topic/mention bindings and history rewriting', async () => {
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  await raw.pragma('foreign_keys = ON');
  try {
    await f.invite();
    const topic = await f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'One',
    });
    await f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({
        topicId: topic.id,
        mentions: [{ kind: 'agent', id: f.agent.id }],
      }),
    );
    const other = await f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'Other',
    });
    for (const table of [
      'channels',
      'topics',
      'messages',
      'message_mentions',
      'communication_outbox',
      'communication_operations',
    ]) {
      await assert.rejects(() => raw.exec('DELETE FROM ' + table));
    }
    await assert.rejects(() =>
      raw.prepare('UPDATE messages SET body=?').run('rewrite'),
    );
    await assert.rejects(() =>
      raw
        .prepare(
          'INSERT INTO messages (id,channel_id,topic_id,author,created_at,body) VALUES (?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          other.id,
          topic.id,
          '{}',
          new Date().toISOString(),
          'Invalid target',
        ),
    );
    await assert.rejects(() =>
      raw
        .prepare('INSERT INTO channel_participants VALUES (?,?,?,?,?,?)')
        .run(
          other.id,
          f.teamId,
          'human:' + f.agent.id,
          f.agent.id,
          null,
          'joined',
        ),
    );
    const rows = z
      .array(z.object({ fact: z.string() }))
      .parse(await raw.prepare('SELECT fact FROM communication_outbox').all());
    assert.ok(rows.length >= 4);
  } finally {
    await raw.close();
    await f.dispose();
  }
});
