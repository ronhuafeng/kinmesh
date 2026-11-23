import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, type Refusal } from '../src/domain/errors.js';
import type { Member } from '../src/domain/communication.js';
import { TaskResult, principalMember } from '../src/domain/tasks.js';
import { key } from './communication-helpers.js';
import { rawDatabase } from './raw.js';
import { taskFixture } from './task-helpers.js';

const rejected = (kind: Refusal) => (e: unknown) =>
  e instanceof DomainError && e.kind === kind;

/**
 * Proves only a task's acceptor edits what is asked, in any open state, on
 * the record and waking nobody; that the reviewer stays once review is
 * asked for; and that the acceptor gives unstarted work to someone.
 */
await test('the acceptor edits an open task on the record; the reviewer stays once review is asked', async () => {
  const f = await taskFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    const reviewer = { kind: 'agent', id: f.reviewer.id } as const;
    let task = (
      await f.act(f.developer, (await f.create()).task, { type: 'claim' })
    ).task;
    const edit = (
      fields: Partial<{
        title: string;
        description: string;
        criteria: string[];
        reviewer: Member | null;
      }>,
    ) => ({
      type: 'edit' as const,
      title: task.title,
      description: task.description,
      criteria: task.criteria,
      reviewer: task.state.reviewer,
      ...fields,
    });
    const woken = () =>
      raw.prepare('SELECT count(*)::int AS n FROM agent_inbox').pluck().get();
    const before = await woken();
    await f.store.notifications.take(10);
    const response = await f.app.inject({
      method: 'POST',
      url: `${f.taskPath}/${task.id}/edit`,
      cookies: f.cookies,
      // The route names the command; the body has no type.
      payload: {
        operationKey: key(),
        expectedVersion: task.version,
        title: 'Implement the bounded change',
        description: task.description,
        criteria: ['Reviewed evidence', 'Human acceptance', 'Docs updated'],
        reviewer,
      },
    });
    assert.equal(response.statusCode, 200);
    const edited = TaskResult.parse(response.json<unknown>()).task;
    assert.equal(edited.title, 'Implement the bounded change');
    assert.deepEqual(edited.criteria.at(-1), 'Docs updated');
    assert.deepEqual(edited.state.reviewer, reviewer);
    // Same status and owner, one version on; nobody woken or told.
    assert.equal(edited.state.status, 'in-progress');
    assert.deepEqual(edited.state.owner, principalMember(f.developer));
    assert.equal(edited.version, task.version + 1);
    assert.equal(await woken(), before);
    assert.deepEqual(await f.store.notifications.take(10), []);
    const last = (
      await f.tasks.history(f.principal, f.teamId, f.channelId, task.id)
    ).items.at(-1);
    assert.equal(last?.action, 'edit');
    assert.equal(last.before?.title, 'Implement bounded change');
    assert.equal(last.after.title, 'Implement the bounded change');
    task = edited;

    // Only the acceptor; an edit changes something; never the owner as reviewer.
    await assert.rejects(
      () => f.act(f.developer, task, edit({ title: 'Mine' })),
      rejected('forbidden'),
    );
    await assert.rejects(
      () => f.act(f.principal, task, edit({})),
      rejected('invalid'),
    );
    await assert.rejects(
      () =>
        f.act(
          f.principal,
          task,
          edit({ reviewer: principalMember(f.developer) }),
        ),
      rejected('conflict'),
    );

    // Under review the reviewer is settled; what is asked can still change.
    task = (
      await f.act(f.developer, task, {
        type: 'request-review',
        reviewer,
        note: 'Ready',
      })
    ).task;
    await assert.rejects(
      () => f.act(f.principal, task, edit({ reviewer: null })),
      rejected('conflict'),
    );
    task = (
      await f.act(f.principal, task, edit({ description: 'Sharper scope' }))
    ).task;
    assert.equal(task.description, 'Sharper scope');
    assert.equal(task.state.status, 'review-requested');

    // Below the code: where a task lives and who decides never change.
    await assert.rejects(
      () =>
        raw.exec(
          "UPDATE tasks SET acceptor_human_id = 'x', version = version + 1",
        ),
      /immutable task contract/,
    );
  } finally {
    await raw.close();
    await f.dispose();
  }
});

await test('the acceptor gives a task nobody started to someone, keeping its reviewer', async () => {
  const f = await taskFixture();
  try {
    const reviewer = { kind: 'agent', id: f.reviewer.id } as const;
    const task = (await f.create({ reviewer })).task;
    await assert.rejects(
      () =>
        f.act(f.principal, task, {
          type: 'handoff',
          mode: 'work',
          recipient: reviewer,
          note: 'Not the reviewer',
        }),
      rejected('conflict'),
    );
    const given = (
      await f.act(f.principal, task, {
        type: 'handoff',
        mode: 'work',
        recipient: principalMember(f.developer),
        note: 'Yours',
      })
    ).task;
    assert.equal(given.state.status, 'in-progress');
    assert.deepEqual(given.state.owner, principalMember(f.developer));
    assert.deepEqual(given.state.reviewer, reviewer);
    // Someone else can't give it away.
    const other = (await f.create()).task;
    await assert.rejects(
      () =>
        f.act(f.developer, other, {
          type: 'handoff',
          mode: 'work',
          recipient: reviewer,
          note: 'Not mine to give',
        }),
      rejected('forbidden'),
    );
  } finally {
    await f.dispose();
  }
});
