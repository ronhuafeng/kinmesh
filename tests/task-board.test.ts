import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Task } from '../src/domain/tasks.js';
import { pageOf } from '../src/domain/communication.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { rawDatabase } from './raw.js';
import { taskFixture } from './task-helpers.js';

/**
 * Proves the board holds a channel's work by its state, not its age: every
 * unfinished task is on it however old, and finished work comes the most
 * recently finished first, reaching back a page at a time, where a task
 * finishing later never enters an older page.
 */
await test('the board holds every unfinished task, and finished ones by when they finished', async () => {
  const f = await taskFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    // The oldest task stays open; the next one finishes now.
    const open = (await f.create({ title: 'Oldest, still open' })).task;
    const last = (await f.create({ title: 'Finished last' })).task;
    await f.act(f.principal, last, { type: 'cancel', note: 'Not needed' });
    // Two tasks created after it that finished long before, copied from it
    // below the API (a finished task never changes, so they are made so).
    const copy = raw.prepare(
      `INSERT INTO tasks (id, team_id, channel_id, topic_id, title, description, criteria, creator,
         acceptor_human_id, state, status, owner_key, version, created_at, updated_at)
       SELECT gen_random_uuid()::text, team_id, channel_id, topic_id, ?, description, criteria,
         creator, acceptor_human_id, state, status, owner_key, version, created_at, ?
       FROM tasks WHERE id = ?`,
    );
    await copy.run('Finished long ago', '2000-01-02T00:00:00.000Z', last.id);
    await copy.run('Finished longest ago', '2000-01-01T00:00:00.000Z', last.id);

    const workspace = await f.app.inject({
      url: '/api/workspace?channelId=' + f.channelId,
      cookies: f.cookies,
    });
    const board = WorkspaceSnapshot.parse(workspace.json()).tasks;
    assert.deepEqual(
      board.items.map((t) => t.title),
      [
        'Oldest, still open',
        'Finished last',
        'Finished long ago',
        'Finished longest ago',
      ],
    );
    assert.equal(board.nextCursor, null);

    // A page at a time, the most recently finished first.
    const page = async (cursor?: string) => {
      const response = await f.app.inject({
        url:
          f.taskPath +
          '?finished=true&limit=2' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        headers: f.developerHeaders,
      });
      assert.equal(response.statusCode, 200);
      return pageOf(Task).parse(response.json());
    };
    const one = await page();
    assert.deepEqual(
      one.items.map((t) => t.title),
      ['Finished last', 'Finished long ago'],
    );
    assert.ok(one.nextCursor);
    // Work finishing now never enters the older page.
    await f.act(f.principal, open, { type: 'cancel', note: 'Done with' });
    const two = await page(one.nextCursor);
    assert.deepEqual(
      two.items.map((t) => t.title),
      ['Finished longest ago'],
    );
    assert.equal(two.nextCursor, null);
    // A cursor of the other list reads nothing here.
    const listed = await f.app.inject({
      url: f.taskPath + '?limit=1',
      headers: f.developerHeaders,
    });
    const cursor = pageOf(Task).parse(listed.json()).nextCursor;
    assert.ok(cursor);
    const wrong = await f.app.inject({
      url: f.taskPath + '?finished=true&cursor=' + encodeURIComponent(cursor),
      headers: f.developerHeaders,
    });
    assert.equal(wrong.statusCode, 400);
  } finally {
    await raw.close();
    await f.dispose();
  }
});
