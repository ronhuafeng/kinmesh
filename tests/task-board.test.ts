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
    // The oldest task stays open; the next two finish, the older one last.
    const open = (await f.create({ title: 'Oldest, still open' })).task;
    const first = (await f.create({ title: 'Created first' })).task;
    const second = (await f.create({ title: 'Created second' })).task;
    await f.act(f.principal, second, { type: 'cancel', note: 'Not needed' });
    await f.act(f.principal, first, { type: 'cancel', note: 'Not needed' });
    // When each finished, set below the API so the order never hangs on the
    // clock's resolution.
    const finish = raw.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
    await finish.run('2030-01-01T00:00:02.000Z', first.id);
    await finish.run('2030-01-01T00:00:01.000Z', second.id);

    const workspace = await f.app.inject({
      url: '/api/workspace?channelId=' + f.channelId,
      cookies: f.cookies,
    });
    const board = WorkspaceSnapshot.parse(workspace.json()).tasks;
    assert.deepEqual(
      board.items.map((t) => t.title),
      ['Oldest, still open', 'Created first', 'Created second'],
    );
    assert.equal(board.nextCursor, null);

    // A page at a time, the most recently finished first.
    const page = async (cursor?: string) => {
      const response = await f.app.inject({
        url:
          f.taskPath +
          '?finished=true&limit=1' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        headers: f.developerHeaders,
      });
      assert.equal(response.statusCode, 200);
      return pageOf(Task).parse(response.json());
    };
    const one = await page();
    assert.deepEqual(
      one.items.map((t) => t.id),
      [first.id],
    );
    assert.ok(one.nextCursor);
    // Work finishing now never enters the older page.
    await f.act(f.principal, open, { type: 'cancel', note: 'Done with' });
    const two = await page(one.nextCursor);
    assert.deepEqual(
      two.items.map((t) => t.id),
      [second.id],
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
