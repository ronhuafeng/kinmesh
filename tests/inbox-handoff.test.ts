import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliver } from '../src/inbox/worker.js';
import { FrozenLaunch } from '../src/domain/inbox.js';
import { inboxFixture, assistantRead, due } from './inbox-helpers.js';
import {
  envelope,
  options,
  reference,
  launch,
  launched,
} from './t3-helpers.js';
import { profileInput } from './agent-helpers.js';
import { postInput } from './communication-helpers.js';
import { MessageId } from '../src/domain/communication.js';

const signal = () => new AbortController().signal;

await test('MOCK native: developer settles the exact Run after its own review handoff without revising the task', async () => {
  const f = await inboxFixture();
  try {
    let task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    let handed = false;
    f.wire.handler = async (name) => {
      if (name === 't3_thread_read' && !handed) {
        task = (
          await f.act(f.developer, task, {
            type: 'handoff',
            mode: 'review',
            recipient: { kind: 'agent', id: f.reviewer.id },
            note: 'Artifact complete; independent review requested.',
          })
        ).task;
        handed = true;
      }
      return Promise.resolve(envelope(f.wire.values[name]));
    };
    await deliver(f.store, claim, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(claim.id)).state, 'acked');
    assert.deepEqual(
      await f.tasks.get(f.principal, f.teamId, f.channelId, task.id),
      task,
    );
    assert.equal(task.state.status, 'review-requested');
    assert.equal(
      (await f.tasks.executions(f.principal, f.teamId, f.channelId, task.id))
        .items.length,
      1,
    );
    assert.equal(
      (await f.rows()).filter((r) => r.agentId === f.reviewer.id).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

await test('MOCK native: retry after developer handoff reads the existing Run and does not launch again', async () => {
  const f = await inboxFixture();
  try {
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const first = await f.inbox.claim([f.agent.id]);
    assert.ok(first);
    f.wire.values.t3_thread_read = assistantRead('Still working', 'running');
    await deliver(f.store, first, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(first.id)).state, 'waiting');
    await f.act(f.developer, task, {
      type: 'handoff',
      mode: 'review',
      recipient: { kind: 'agent', id: f.reviewer.id },
      note: 'Review the completed artifact.',
    });
    f.wire.values.t3_thread_read = assistantRead();
    await due(f.dbPath);
    const retry = await f.inbox.claim([f.agent.id]);
    assert.ok(retry);
    await deliver(f.store, retry, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(first.id)).state, 'acked');
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

for (const outcome of [
  'awaiting-human',
  'accepted',
  'rework-requested',
  'in-progress',
  'cancelled',
  'revoked',
])
  await test(`MOCK native: reviewer settlement respects ${outcome}`, async () => {
    const f = await inboxFixture();
    try {
      await f.store.agents.update(f.principal, f.teamId, f.reviewer.id, {
        ...profileInput,
        name: 'Reviewer',
        role: 'reviewer',
        preferences: (
          await f.store.agents.get(f.principal, f.teamId, f.agent.id)
        ).preferences,
      });
      const grant = await f.store.agents.issue(
        f.principal,
        f.teamId,
        f.reviewer.id,
        {
          label: 'Reviewer Inbox settlement',
          scopes: [
            'channels:read',
            'channels:write',
            'tasks:read',
            'tasks:write',
            'tasks:review',
            'executions:write',
          ],
          lifetimeSeconds: 3600,
        },
      );
      const tokenFile = join(f.directory, 'reviewer-worker.json');
      writeFileSync(tokenFile, JSON.stringify({ token: grant.token }), {
        mode: 0o600,
      });
      let task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
        .task;
      task = (
        await f.act(f.developer, task, {
          type: 'handoff',
          mode: 'review',
          recipient: { kind: 'agent', id: f.reviewer.id },
          note: 'Independent review.',
        })
      ).task;
      const claim = await f.inbox.claim([f.reviewer.id]);
      assert.ok(claim);
      let reviewed = false;
      f.wire.handler = async (name) => {
        if (name === 't3_thread_read' && !reviewed) {
          task = (
            await f.act(f.reviewPrincipal, task, {
              type: 'review',
              decision: 'approve',
              note: 'The artifact meets the criteria.',
            })
          ).task;
          if (outcome === 'accepted')
            task = (
              await f.act(f.principal, task, {
                type: 'accept',
                note: 'The designated human explicitly accepts.',
              })
            ).task;
          if (outcome === 'cancelled')
            task = (
              await f.act(f.principal, task, {
                type: 'cancel',
                note: 'The designated human cancels before publication.',
              })
            ).task;
          if (outcome === 'rework-requested' || outcome === 'in-progress') {
            task = (
              await f.act(f.principal, task, {
                type: 'rework',
                note: 'Human requests another pass while the old Run settles.',
              })
            ).task;
            if (outcome === 'in-progress')
              task = (
                await f.act(f.developer, task, {
                  type: 'progress',
                  note: 'Developer has started the human-requested rework.',
                })
              ).task;
          }
          if (outcome === 'revoked')
            await f.store.agents.revoke(
              f.principal,
              f.teamId,
              f.reviewer.id,
              grant.grant.id,
            );
          reviewed = true;
        }
        return Promise.resolve(envelope(f.wire.values[name]));
      };
      await deliver(
        f.store,
        claim,
        { ...f.binding, agentId: f.reviewer.id, tokenFile },
        f.factory,
        signal(),
      );
      const denied = outcome === 'cancelled' || outcome === 'revoked';
      const row = await f.inbox.get(claim.id);
      assert.equal(row.state, denied ? 'blocked' : 'acked');
      assert.notEqual(row.reference, null);
      assert.equal(row.resultMessageId === null, denied);
      assert.deepEqual(
        await f.tasks.get(f.principal, f.teamId, f.channelId, task.id),
        task,
      );
      assert.equal(
        task.state.status,
        outcome === 'revoked' ? 'awaiting-human' : outcome,
      );
      const links = (
        await f.tasks.executions(f.principal, f.teamId, f.channelId, task.id)
      ).items;
      assert.equal(links.length, denied ? 0 : 1);
      if (!denied) assert.deepEqual(links[0]?.reference, reference);
    } finally {
      await f.dispose();
    }
  });

await test('MOCK native: human work reassignment after launch still blocks the old agent publication', async () => {
  const f = await inboxFixture();
  try {
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    let reassigned = false;
    f.wire.handler = async (name) => {
      if (name === 't3_thread_read' && !reassigned) {
        await f.act(f.principal, task, {
          type: 'handoff',
          mode: 'work',
          recipient: { kind: 'agent', id: f.reviewer.id },
          note: 'Human transfers the responsibility.',
        });
        reassigned = true;
      }
      return Promise.resolve(envelope(f.wire.values[name]));
    };
    await deliver(f.store, claim, f.binding, f.factory, signal());
    const row = await f.inbox.get(claim.id);
    assert.equal(row.state, 'blocked');
    assert.notEqual(row.reference, null);
    assert.equal(row.resultMessageId, null);
    assert.equal(
      (await f.tasks.executions(f.principal, f.teamId, f.channelId, task.id))
        .items.length,
      0,
    );
  } finally {
    await f.dispose();
  }
});

await test('MOCK native: a frozen context without a native intent does not permit a new launch after handoff', async () => {
  const f = await inboxFixture();
  try {
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    assert.equal(f.workerPrincipal.kind, 'agent');
    await f.inbox.freeze(
      claim,
      f.workerPrincipal,
      FrozenLaunch.parse({
        grantId: f.workerPrincipal.grantId,
        execution: {
          endpoint: options.endpoint,
          environmentId: reference.environmentId,
          authority: options.authority,
        },
        input: { ...launch, message: 'Frozen before any native dispatch' },
      }),
    );
    await f.act(f.developer, task, {
      type: 'handoff',
      mode: 'review',
      recipient: { kind: 'agent', id: f.reviewer.id },
      note: 'Review is already requested elsewhere.',
    });
    await deliver(f.store, claim, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(claim.id)).state, 'blocked');
    assert.equal(f.wire.calls.length, 0);
  } finally {
    await f.dispose();
  }
});

await test('MOCK native: a known journal receipt recovers across handoff before the Inbox remembers its reference', async () => {
  const f = await inboxFixture();
  try {
    let task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    const factory: typeof f.factory = async (...args) => {
      const handle = await f.factory(...args);
      const backend = handle.backend;
      const nativeLaunch = backend.launch.bind(backend);
      backend.launch = async (...input) => {
        await nativeLaunch(...input);
        task = (
          await f.act(f.developer, task, {
            type: 'handoff',
            mode: 'review',
            recipient: { kind: 'agent', id: f.reviewer.id },
            note: 'Completed before the receipt reaches the Inbox.',
          })
        ).task;
        throw new Error('Lost return after the native journal is known');
      };
      return handle;
    };
    await deliver(f.store, claim, f.binding, factory, signal());
    assert.equal((await f.inbox.get(claim.id)).state, 'uncertain');
    assert.equal((await f.inbox.get(claim.id)).reference, null);
    await due(f.dbPath);
    const retry = await f.inbox.claim([f.agent.id]);
    assert.ok(retry);
    await deliver(f.store, retry, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(claim.id)).state, 'acked');
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

/**
 * Proves a delivery sent into the conversation's existing thread counts as
 * the agent's own dispatch, exactly as the launch that started the thread
 * does: its answer still posts after the agent asks for review.
 */
await test('MOCK native: a task wake sent into a conversation the agent already answered in settles after its own review request', async () => {
  const f = await inboxFixture();
  try {
    // The agent's first answer in the channel starts its thread.
    await f.store.messages.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
    );
    const first = await f.inbox.claim([f.agent.id]);
    assert.ok(first);
    await deliver(f.store, first, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(first.id)).state, 'acked');

    // The task's wake is sent into that thread and starts its next run.
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const run = 'fixture-task-run';
    const thread = (status: string, text?: string) => {
      const base = assistantRead(text);
      const [recent] = base.recentRuns;
      const [item] = base.items;
      assert.ok(recent && item);
      return {
        ...base,
        thread: {
          ...base.thread,
          status,
          activeRunId: status === 'running' ? run : null,
          latestRunId: run,
        },
        recentRuns: [{ ...recent, runId: run, status }],
        items: text === undefined ? [] : [{ ...item, runId: run, position: 6 }],
      };
    };
    f.wire.values.t3_thread_send = {
      threadId: launched.threadId,
      messageId: 'fixture-sent-message',
      runId: run,
      status: 'running',
      delivery: 'started',
    };
    f.wire.values.t3_thread_read = thread('running');
    const wake = await f.inbox.claim([f.agent.id]);
    assert.ok(wake);
    assert.equal(wake.taskId, task.id);
    await deliver(f.store, wake, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(wake.id)).state, 'waiting');

    // The agent finishes: it asks for review, then writes its reply.
    await f.act(f.developer, task, {
      type: 'request-review',
      reviewer: { kind: 'agent', id: f.reviewer.id },
      note: 'Done; please review.',
    });
    f.wire.values.t3_thread_read = thread('completed', 'The work is done.');
    await due(f.dbPath);
    const retry = await f.inbox.claim([f.agent.id]);
    assert.ok(retry);
    assert.equal(retry.id, wake.id);
    await deliver(f.store, retry, f.binding, f.factory, signal());
    const settled = await f.inbox.get(wake.id);
    assert.equal(settled.state, 'acked', settled.reason);
    assert.equal(
      (
        await f.store.messages.message(
          f.principal,
          f.teamId,
          f.channelId,
          MessageId.parse(settled.resultMessageId),
        )
      ).body,
      'The work is done.',
    );
    // One thread, one message into it: the retry only read.
    const called = (name: string) =>
      f.wire.calls.filter((c) => c.name === name).length;
    assert.equal(called('t3_thread_launch'), 1);
    assert.equal(called('t3_thread_send'), 1);
  } finally {
    await f.dispose();
  }
});
