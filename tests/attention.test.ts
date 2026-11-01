import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { inboxFixture } from './inbox-helpers.js';
import { key, postInput } from './communication-helpers.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
const snapshot = async (f: Fixture, channelId: string) =>
  WorkspaceSnapshot.parse(
    (
      await f.app.inject({
        url: '/api/workspace?channelId=' + channelId,
        cookies: f.cookies,
      })
    ).json<unknown>(),
  );
const elsewhere = (f: Fixture) =>
  f.comm.createChannel(f.principal, f.teamId, {
    operationKey: key(),
    name: 'elsewhere',
  }).id;

await test('a decision waiting in another channel is listed, and only while I am a member', async () => {
  const f = await inboxFixture();
  try {
    const other = elsewhere(f);
    let task = f.create({ owner: null, reviewer: null }).task;
    task = f.act(f.developer, task, { type: 'claim' }).task;
    task = f.act(f.developer, task, {
      type: 'request-review',
      reviewer: { kind: 'agent', id: f.reviewer.id },
      note: 'Ready',
    }).task;
    // Waiting on the reviewer agent, not on me.
    assert.deepEqual((await snapshot(f, other)).attention.decide, []);
    task = f.act(f.reviewPrincipal, task, {
      type: 'review',
      decision: 'approve',
      note: 'Looks right',
    }).task;
    const decide = (await snapshot(f, other)).attention.decide;
    assert.deepEqual(
      decide.map((d) => [d.task.id, d.task.state.status, d.channelName]),
      [[task.id, 'awaiting-human', 'general']],
    );
    // Leaving the channel takes its asks with it.
    f.comm.membership(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    assert.deepEqual((await snapshot(f, other)).attention.decide, []);
  } finally {
    await f.dispose();
  }
});

await test('blocked deliveries and unwakeable agents are listed without worker internals', async () => {
  const f = await inboxFixture();
  try {
    const other = elsewhere(f);
    f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({
        body: 'Ada, please check this',
        mentions: [{ kind: 'agent', id: f.agent.id }],
      }),
    );
    // Queued for an agent no worker serves: set it up.
    let attention = (await snapshot(f, other)).attention;
    assert.deepEqual(attention.connect, [{ agentId: f.agent.id, queued: 1 }]);
    assert.deepEqual(attention.unstuck, []);
    f.inbox.heartbeat([f.agent.id]);
    assert.deepEqual((await snapshot(f, other)).attention.connect, []);
    // A blocking failure becomes something to unstick.
    const claim = f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    f.inbox.defer(claim, 'blocked', 'authority-or-contract-blocked');
    attention = (await snapshot(f, other)).attention;
    assert.equal(attention.unstuck.length, 1);
    const [item] = attention.unstuck;
    assert.equal(item?.id, claim.id);
    assert.equal(item.channelId, f.channelId);
    assert.equal(item.state, 'blocked');
    assert.deepEqual(Object.keys(item).sort(), [
      'agentId',
      'channelId',
      'channelName',
      'id',
      'messageId',
      'queuedAt',
      'reason',
      'resultMessageId',
      'state',
      'taskId',
      'updatedAt',
    ]);
    f.comm.membership(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    assert.deepEqual((await snapshot(f, other)).attention.unstuck, []);
  } finally {
    await f.dispose();
  }
});
