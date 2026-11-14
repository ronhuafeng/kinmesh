import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { inboxFixture } from './inbox-helpers.js';
import { key, postInput } from './communication-helpers.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
const raw = async (f: Fixture, channelId: string) =>
  (
    await f.app.inject({
      url: '/api/workspace?channelId=' + channelId,
      cookies: f.cookies,
    })
  ).json<{ attention: { unstuck: object[] } }>();
const snapshot = async (f: Fixture, channelId: string) =>
  WorkspaceSnapshot.parse(await raw(f, channelId));
/** Inbox row columns a worker owns; none may reach the browser. */
const WORKER_INTERNALS = [
  'claimToken',
  'leaseUntil',
  'nextAttempt',
  'attempts',
  'generation',
  'launch',
  'operationId',
  'reference',
  'eventId',
  'rootId',
  'expiresAt',
  'position',
];
const elsewhere = async (f: Fixture) =>
  (
    await f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'elsewhere',
    })
  ).id;

await test('a decision waiting in another channel is listed, and only while I am a member', async () => {
  const f = await inboxFixture();
  try {
    const other = await elsewhere(f);
    let task = (await f.create({ owner: null, reviewer: null })).task;
    task = (await f.act(f.developer, task, { type: 'claim' })).task;
    task = (
      await f.act(f.developer, task, {
        type: 'request-review',
        reviewer: { kind: 'agent', id: f.reviewer.id },
        note: 'Ready',
      })
    ).task;
    // Waiting on the reviewer agent, not on me.
    assert.deepEqual((await snapshot(f, other)).attention.decide, []);
    task = (
      await f.act(f.reviewPrincipal, task, {
        type: 'review',
        decision: 'approve',
        note: 'Looks right',
      })
    ).task;
    const decide = (await snapshot(f, other)).attention.decide;
    assert.deepEqual(
      decide.map((d) => [d.task.id, d.task.state.status, d.channelName]),
      [[task.id, 'awaiting-human', 'general']],
    );
    // Leaving the channel takes its asks with it.
    await f.comm.membership(
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
    const other = await elsewhere(f);
    await f.comm.post(
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
    await f.inbox.heartbeat([f.agent.id]);
    assert.deepEqual((await snapshot(f, other)).attention.connect, []);
    // A blocking failure becomes something to unstick.
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    await f.inbox.defer(claim, 'blocked', 'authority-or-contract-blocked');
    attention = (await snapshot(f, other)).attention;
    assert.equal(attention.unstuck.length, 1);
    const [item] = attention.unstuck;
    assert.equal(item?.id, claim.id);
    assert.equal(item.channelId, f.channelId);
    assert.equal(item.state, 'blocked');
    const [sent] = (await raw(f, other)).attention.unstuck;
    for (const internal of WORKER_INTERNALS)
      assert.equal(Object.hasOwn(sent ?? {}, internal), false, internal);
    await f.comm.membership(
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
