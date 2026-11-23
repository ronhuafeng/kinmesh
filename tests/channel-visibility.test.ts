import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelId } from '../src/domain/contracts.js';
import { DomainError } from '../src/domain/errors.js';
import { key, postInput } from './communication-helpers.js';
import { taskFixture, taskInput } from './task-helpers.js';
import { feishuPerson, signInAs } from './feishu.js';

const notFound = (e: unknown) =>
  e instanceof DomainError && e.kind === 'not-found';

await test('a public channel is open to read for every person of the team; writing, and every agent, needs joining', async () => {
  const f = await taskFixture();
  try {
    await signInAs(f.app, 'grace@example.com');
    const grace = {
      kind: 'human',
      humanId: (await f.store.signIn(feishuPerson('grace@example.com'))).id,
    } as const;
    const grant = await f.store.agents.issue(
      f.principal,
      f.teamId,
      f.agent.id,
      {
        label: 'Visibility test',
        scopes: ['channels:read', 'channels:write'],
        lifetimeSeconds: 600,
      },
    );
    const agent = await f.store.agents.resolveToken(grant.token);
    const made = await f.app.inject({
      method: 'POST',
      url: `/api/teams/${f.teamId}/channels`,
      cookies: f.cookies,
      payload: { operationKey: key(), name: 'open', visibility: 'public' },
    });
    assert.equal(made.statusCode, 201);
    const open = await f.store.channels.channel(
      f.principal,
      f.teamId,
      ChannelId.parse(made.json<{ id: string }>().id),
    );
    assert.equal(open.visibility, 'public');
    // Without saying, a channel is private.
    const closed = await f.store.channels.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'closed',
    });
    assert.equal(closed.visibility, 'private');
    await f.store.messages.post(f.principal, f.teamId, open.id, postInput());

    // Grace is offered the public one only, and reads it without joining.
    const offered = async () =>
      (await f.store.channels.publicChannels(grace, f.teamId)).map((c) => c.id);
    assert.ok((await offered()).includes(open.id));
    assert.ok(!(await offered()).includes(closed.id));
    await f.store.channels.channel(grace, f.teamId, open.id);
    assert.equal(
      (await f.store.messages.history(grace, f.teamId, open.id)).items.length,
      1,
    );
    await f.store.files.files(grace, f.teamId, null, 50, open.id);
    await assert.rejects(
      f.store.channels.channel(grace, f.teamId, closed.id),
      notFound,
    );

    // Nothing is written by looking: no message, topic, task or read mark.
    await assert.rejects(
      f.store.messages.post(grace, f.teamId, open.id, postInput()),
      notFound,
    );
    await assert.rejects(
      f.store.topics.createTopic(grace, f.teamId, open.id, {
        operationKey: key(),
        title: 'Peek',
      }),
      notFound,
    );
    await assert.rejects(
      f.store.tasks.create(grace, f.teamId, open.id, taskInput()),
      notFound,
    );
    await assert.rejects(
      f.store.channels.setVisibility(grace, f.teamId, open.id, {
        operationKey: key(),
        visibility: 'private',
      }),
      notFound,
    );

    // An agent never looks in or joins by itself.
    assert.deepEqual(
      await f.store.channels.publicChannels(agent, f.teamId),
      [],
    );
    await assert.rejects(
      f.store.channels.channel(agent, f.teamId, open.id),
      notFound,
    );
    await assert.rejects(
      f.store.channels.membership(
        agent,
        f.teamId,
        open.id,
        { operationKey: key() },
        'subscribe',
      ),
      notFound,
    );

    // Grace joins: she writes there, and it is no longer offered.
    const joined = await f.app.inject({
      method: 'POST',
      url: `/api/teams/${f.teamId}/channels/${open.id}/subscribe`,
      cookies: await signInAs(f.app, 'grace@example.com'),
      payload: { operationKey: key() },
    });
    assert.equal(joined.statusCode, 200);
    await f.store.messages.post(grace, f.teamId, open.id, postInput());
    assert.ok(!(await offered()).includes(open.id));

    // Removed is final: no looking in, no joining back.
    await f.store.channels.enroll(
      f.principal,
      f.teamId,
      open.id,
      { operationKey: key(), member: { kind: 'human', id: grace.humanId } },
      'remove',
    );
    await assert.rejects(
      f.store.channels.channel(grace, f.teamId, open.id),
      notFound,
    );
    await assert.rejects(
      f.store.channels.membership(
        grace,
        f.teamId,
        open.id,
        { operationKey: key() },
        'subscribe',
      ),
      notFound,
    );
    assert.ok(!(await offered()).includes(open.id));

    // Someone in the channel makes it private, on the record.
    const switched = await f.app.inject({
      method: 'POST',
      url: `/api/teams/${f.teamId}/channels/${open.id}/visibility`,
      cookies: f.cookies,
      payload: { operationKey: key(), visibility: 'private' },
    });
    assert.equal(switched.statusCode, 200);
    assert.equal(
      (await f.store.channels.channel(f.principal, f.teamId, open.id))
        .visibility,
      'private',
    );
    const facts = (
      await f.store.messages.events(f.principal, f.teamId, open.id)
    ).items.map((e) => e.fact);
    const change = facts.find((fact) => fact.kind === 'channel.changed');
    assert.equal(
      change && 'visibility' in change ? change.visibility : null,
      'private',
    );
  } finally {
    await f.dispose();
  }
});
