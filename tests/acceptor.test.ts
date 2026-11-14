import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { IdentityError } from '../src/domain/agents.js';
import { inboxFixture } from './inbox-helpers.js';
import { postInput } from './communication-helpers.js';
import { taskInput } from './task-helpers.js';
import { feishuPerson, signInAs } from './feishu.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
const rejected = (status: number) => (e: unknown) =>
  e instanceof IdentityError && e.statusCode === status;
/** Grace, another person of the organization, signed in and in #general. */
async function grace(f: Fixture) {
  const cookies = await signInAs(f.app, 'grace@example.com');
  const human = f.store.signIn(feishuPerson('grace@example.com'));
  return {
    cookies,
    human,
    principal: { kind: 'human', humanId: human.id } as const,
  };
}
const mention = (f: Fixture, author: Fixture['principal']) =>
  f.comm.post(
    author,
    f.teamId,
    f.channelId,
    postInput({
      body: 'Ada, please take this on',
      mentions: [{ kind: 'agent', id: f.agent.id }],
    }),
  );

await test('a task is decided by the person who asked for it, or by whom they name', async () => {
  const f = await inboxFixture();
  try {
    const g = await grace(f);
    // Asked by Grace, not by whoever set up the team.
    const hers = f.store.tasks.create(
      g.principal,
      f.teamId,
      f.channelId,
      taskInput(),
    ).task;
    assert.equal(hers.acceptorHumanId, g.human.id);
    // The owner of the team asks it of Grace.
    const named = f.store.tasks.create(
      f.principal,
      f.teamId,
      f.channelId,
      taskInput({ acceptor: g.human.id }),
    ).task;
    assert.equal(named.acceptorHumanId, g.human.id);
    // Only someone in the channel can be named, and never by an agent.
    assert.throws(
      () =>
        f.store.tasks.create(
          f.principal,
          f.teamId,
          f.channelId,
          taskInput({ acceptor: '00000000-0000-4000-8000-000000000009' }),
        ),
      rejected(404),
    );
    assert.throws(
      () =>
        f.store.tasks.create(
          f.developer,
          f.teamId,
          f.channelId,
          taskInput({ acceptor: g.human.id }),
        ),
      rejected(403),
    );
    // Only the acceptor decides: the person who set up the team cannot.
    let task = f.act(f.developer, hers, { type: 'claim' }).task;
    task = f.act(f.developer, task, {
      type: 'request-review',
      reviewer: { kind: 'agent', id: f.reviewer.id },
      note: 'Ready',
    }).task;
    task = f.act(f.reviewPrincipal, task, {
      type: 'review',
      decision: 'approve',
      note: 'Fine',
    }).task;
    assert.throws(
      () => f.act(f.principal, task, { type: 'accept', note: 'Not mine' }),
      rejected(403),
    );
    assert.equal(
      f.act(g.principal, task, { type: 'accept', note: 'Mine' }).task.state
        .status,
      'accepted',
    );
  } finally {
    await f.dispose();
  }
});

await test('an agent’s task is decided by the person whose mention it answers', async () => {
  const f = await inboxFixture();
  try {
    const g = await grace(f);
    // The team's first person speaks last, but Grace asked.
    mention(f, g.principal);
    const claim = f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    f.comm.post(f.principal, f.teamId, f.channelId, postInput({ body: 'FYI' }));
    const answered = f.store.tasks.create(
      f.developer,
      f.teamId,
      f.channelId,
      taskInput({ sourceEventId: claim.eventId }),
    ).task;
    assert.equal(answered.acceptorHumanId, g.human.id);
    // With no cause given, the person who last spoke in the channel.
    const unprompted = f.store.tasks.create(
      f.developer,
      f.teamId,
      f.channelId,
      taskInput(),
    ).task;
    assert.equal(unprompted.acceptorHumanId, f.owner.id);
  } finally {
    await f.dispose();
  }
});

await test('each person is asked to unstick only the deliveries they caused', async () => {
  const f = await inboxFixture();
  try {
    const g = await grace(f);
    const unstuck = async (cookies: Record<string, string>) =>
      WorkspaceSnapshot.parse(
        (
          await f.app.inject({ url: '/api/workspace', cookies })
        ).json<unknown>(),
      ).attention.unstuck.map((d) => d.id);
    mention(f, f.principal);
    const mine = f.inbox.claim([f.agent.id]);
    assert.ok(mine);
    f.inbox.defer(mine, 'blocked', 'authority-or-contract-blocked');
    mention(f, g.principal);
    const hers = f.inbox.claim([f.agent.id]);
    assert.ok(hers);
    f.inbox.defer(hers, 'blocked', 'authority-or-contract-blocked');
    assert.deepEqual(await unstuck(f.cookies), [mine.id]);
    assert.deepEqual(await unstuck(g.cookies), [hers.id]);
    // Anyone may still resume either.
    const resumed = await f.app.inject({
      method: 'POST',
      url: `/api/teams/${f.teamId}/deliveries/${mine.id}/resume`,
      cookies: g.cookies,
      payload: { operationKey: crypto.randomUUID() },
    });
    assert.equal(resumed.statusCode < 300, true);
  } finally {
    await f.dispose();
  }
});
