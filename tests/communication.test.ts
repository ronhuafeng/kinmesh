import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { HumanId, TeamId } from '../src/domain/contracts.js';
import { IdentityError, type Principal } from '../src/domain/agents.js';
import {
  ChannelView,
  CommunicationFact,
  Event,
  Message,
  PageInput,
  PostInput,
  Topic,
  pageOf,
} from '../src/domain/communication.js';
import { createApp } from '../src/server/app.js';
import {
  communicationFixture,
  key,
  postInput,
} from './communication-helpers.js';
import { profileInput } from './agent-helpers.js';
const rejected = (status: number) => (e: unknown) =>
  e instanceof IdentityError && e.statusCode === status;

await test('channel/topic HTTP flow: owner enrolls persistent agent, exchanges attributed messages and continues topic in channel timeline', async () => {
  const f = await communicationFixture();
  try {
    assert.equal(
      (await f.app.inject({ url: f.channelPath, headers: f.headers }))
        .statusCode,
      404,
    );
    assert.equal(
      pageOf(ChannelView).parse(
        (
          await f.app.inject({ url: f.channelsPath, headers: f.headers })
        ).json<unknown>(),
      ).items.length,
      0,
    );
    const invited = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/participants/invite',
      cookies: f.cookies,
      payload: {
        operationKey: key(),
        member: { kind: 'agent', id: f.agent.id },
      },
    });
    assert.equal(invited.statusCode, 200);
    const topicResponse = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/topics',
      cookies: f.cookies,
      payload: { operationKey: key(), title: 'Design discussion' },
    });
    assert.equal(topicResponse.statusCode, 201);
    const topic = Topic.parse(topicResponse.json<unknown>());
    const first = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: postInput({
        topicId: topic.id,
        body: 'Please review',
        mentions: [{ kind: 'agent', id: f.agent.id }],
      }),
    });
    assert.equal(first.statusCode, 201);
    const humanMessage = Message.parse(first.json<unknown>());
    const event = f.comm
      .events(f.principal, f.teamId, f.channelId)
      .items.find((e) => e.fact.messageId === humanMessage.id);
    assert.ok(event);
    const follow = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      headers: f.headers,
      payload: postInput({
        topicId: topic.id,
        body: 'Review complete',
        mentions: [{ kind: 'human', id: f.owner.id }],
        sourceMessageId: humanMessage.id,
        sourceEventId: event.fact.id,
      }),
    });
    assert.equal(follow.statusCode, 201);
    const agentMessage = Message.parse(follow.json<unknown>());
    assert.equal(humanMessage.author.kind, 'human');
    assert.equal(agentMessage.author.kind, 'agent');
    assert.equal(agentMessage.sourceMessageId, humanMessage.id);
    assert.ok(agentMessage.position > humanMessage.position);
    assert.equal(agentMessage.topicId, topic.id);
    for (const path of ['/messages', '/topics/' + topic.id + '/messages']) {
      const response = await f.app.inject({
        url: f.channelPath + path,
        headers: f.headers,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        pageOf(Message)
          .parse(response.json<unknown>())
          .items.map((m) => m.id),
        [humanMessage.id, agentMessage.id],
      );
    }
    const facts = pageOf(Event).parse(
      (
        await f.app.inject({
          url: f.channelPath + '/events',
          headers: f.headers,
        })
      ).json<unknown>(),
    );
    assert.equal(
      facts.items.filter((e) => e.fact.kind === 'message.posted').length,
      2,
    );
    assert.deepEqual(
      facts.items.find((e) => e.fact.messageId === agentMessage.id)?.fact
        .mentions,
      [{ kind: 'human', id: f.owner.id }],
    );
    assert.equal(
      (
        await f.app.inject({
          url: f.channelPath + '/messages/' + agentMessage.id + '/mentions',
          headers: f.headers,
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.dispose();
  }
});

await test('every channel/history/detail/topic/mention/event endpoint hides inaccessible channel IDs and enforces team scope', async () => {
  const f = await communicationFixture();
  try {
    const topic = f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'Private',
    });
    const msg = f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ topicId: topic.id }),
    );
    const reads = [
      '',
      '/membership',
      '/topics',
      '/topics/' + topic.id,
      '/topics/' + topic.id + '/messages',
      '/messages',
      '/messages/' + msg.id,
      '/messages/' + msg.id + '/mentions',
      '/events',
    ];
    for (const path of reads)
      assert.equal(
        (await f.app.inject({ url: f.channelPath + path, headers: f.headers }))
          .statusCode,
        404,
      );
    assert.equal(
      (
        await f.app.inject({
          url: `/api/teams/${f.teamId}/channels/${randomUUID()}`,
          headers: f.headers,
        })
      ).statusCode,
      404,
    );
    for (const [path, payload] of [
      ['/topics', { operationKey: key(), title: 'No' }],
      ['/messages', postInput()],
      ['/subscribe', { operationKey: key() }],
      ['/leave', { operationKey: key() }],
    ] as const)
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: f.channelPath + path,
            headers: f.headers,
            payload,
          })
        ).statusCode,
        404,
      );
    assert.throws(
      () => f.comm.history(f.agentPrincipal, f.teamId, f.channelId),
      rejected(404),
    );
    f.invite();
    assert.equal(
      (
        await f.app.inject({
          url: f.channelPath.replace(f.teamId, randomUUID()) + '/messages',
          headers: f.headers,
        })
      ).statusCode,
      403,
    );
    const other = f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'Other',
    });
    assert.equal(
      (
        await f.app.inject({
          url: `${f.channelsPath}/${other.id}/messages/${msg.id}`,
          cookies: f.cookies,
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.dispose();
  }
});

await test('membership leave/subscribe is self-only; removal prevents resubscription and replay cannot restore privileges', async () => {
  const f = await communicationFixture();
  try {
    f.invite();
    assert.throws(
      () =>
        f.comm.enroll(
          f.principal,
          f.teamId,
          f.channelId,
          { operationKey: key(), member: { kind: 'human', id: f.owner.id } },
          'remove',
        ),
      rejected(400),
    );
    const leave = { operationKey: key() };
    f.comm.membership(f.agentPrincipal, f.teamId, f.channelId, leave, 'leave');
    assert.throws(
      () => f.comm.history(f.agentPrincipal, f.teamId, f.channelId),
      rejected(404),
    );
    assert.equal(
      f.comm.membership(f.agentPrincipal, f.teamId, f.channelId, leave, 'leave')
        .state,
      'left',
    );
    const subscribe = { operationKey: key() };
    f.comm.membership(
      f.agentPrincipal,
      f.teamId,
      f.channelId,
      subscribe,
      'subscribe',
    );
    f.comm.enroll(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), member: { kind: 'agent', id: f.agent.id } },
      'remove',
    );
    assert.throws(
      () =>
        f.comm.membership(
          f.agentPrincipal,
          f.teamId,
          f.channelId,
          subscribe,
          'subscribe',
        ),
      rejected(404),
    );
    assert.equal(f.comm.channels(f.agentPrincipal, f.teamId).items.length, 0);
    f.invite();
    assert.equal(
      f.comm.channel(f.agentPrincipal, f.teamId, f.channelId).id,
      f.channelId,
    );
    const spoof = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/leave',
      headers: f.headers,
      payload: {
        operationKey: key(),
        member: { kind: 'human', id: f.owner.id },
      },
    });
    assert.equal(spoof.statusCode, 400);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.channelPath + '/participants/invite',
          headers: f.headers,
          payload: {
            operationKey: key(),
            member: { kind: 'human', id: f.owner.id },
          },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.dispose();
  }
});

await test('mentions require real active joined human/agent members of this channel/team; causal references cannot cross channels', async () => {
  const f = await communicationFixture();
  try {
    const other = f.store.agents.create(f.principal, f.teamId, {
      ...profileInput,
      name: 'Nonparticipant',
    });
    for (const target of [
      { kind: 'agent', id: other.id },
      { kind: 'human', id: HumanId.parse(randomUUID()) },
    ] as const)
      assert.throws(
        () =>
          f.comm.post(
            f.principal,
            f.teamId,
            f.channelId,
            postInput({ mentions: [target] }),
          ),
        rejected(404),
      );
    f.invite();
    f.store.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'disabled');
    assert.throws(
      () =>
        f.comm.post(
          f.principal,
          f.teamId,
          f.channelId,
          postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
        ),
      rejected(404),
    );
    const second = f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'Other',
    });
    const msg = f.comm.post(f.principal, f.teamId, second.id, postInput());
    const topic = f.comm.createTopic(f.principal, f.teamId, second.id, {
      operationKey: key(),
      title: 'Elsewhere',
    });
    const event = f.comm.events(f.principal, f.teamId, second.id).items[0];
    assert.ok(event);
    for (const partial of [
      { sourceMessageId: msg.id },
      { sourceEventId: event.fact.id },
      { topicId: topic.id },
    ])
      assert.throws(
        () =>
          f.comm.post(f.principal, f.teamId, f.channelId, postInput(partial)),
        rejected(404),
      );
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      0,
    );
  } finally {
    await f.dispose();
  }
});

await test('message idempotency is actor/action/target scoped; same key replay preserves original ID/time/fact, collisions fail', async () => {
  const f = await communicationFixture();
  try {
    f.invite();
    const data = postInput();
    const first = f.comm.post(f.principal, f.teamId, f.channelId, data);
    assert.deepEqual(
      f.comm.post(f.principal, f.teamId, f.channelId, data),
      first,
    );
    assert.throws(
      () =>
        f.comm.post(f.principal, f.teamId, f.channelId, {
          ...data,
          body: 'Changed',
        }),
      rejected(409),
    );
    const agent = f.comm.post(f.agentPrincipal, f.teamId, f.channelId, data);
    assert.notEqual(first.id, agent.id);
    const another = f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'Another',
    });
    assert.notEqual(
      f.comm.post(f.principal, f.teamId, another.id, data).id,
      first.id,
    );
    const facts = f.comm
      .events(f.principal, f.teamId, f.channelId)
      .items.filter((e) => e.fact.kind === 'message.posted');
    assert.equal(facts.length, 2);
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      2,
    );
  } finally {
    await f.dispose();
  }
});

await test('channel/topic/invite/leave/subscribe operations replay exactly and reject key collisions without duplicate outbox facts', async () => {
  const f = await communicationFixture();
  try {
    const input = { operationKey: key(), name: 'Planning' };
    const channel = f.comm.createChannel(f.principal, f.teamId, input);
    assert.deepEqual(
      f.comm.createChannel(f.principal, f.teamId, input),
      channel,
    );
    assert.throws(
      () =>
        f.comm.createChannel(f.principal, f.teamId, {
          ...input,
          name: 'Changed',
        }),
      rejected(409),
    );
    const topicInput = { operationKey: key(), title: 'Topic' };
    const topic = f.comm.createTopic(
      f.principal,
      f.teamId,
      channel.id,
      topicInput,
    );
    assert.deepEqual(
      f.comm.createTopic(f.principal, f.teamId, channel.id, topicInput),
      topic,
    );
    assert.throws(
      () =>
        f.comm.createTopic(f.principal, f.teamId, channel.id, {
          ...topicInput,
          title: 'Changed',
        }),
      rejected(409),
    );
    const invitation = {
      operationKey: key(),
      member: { kind: 'agent' as const, id: f.agent.id },
    };
    assert.deepEqual(
      f.comm.enroll(f.principal, f.teamId, channel.id, invitation, 'invite'),
      f.comm.enroll(f.principal, f.teamId, channel.id, invitation, 'invite'),
    );
    assert.throws(
      () =>
        f.comm.enroll(
          f.principal,
          f.teamId,
          channel.id,
          { ...invitation, member: { kind: 'human', id: f.owner.id } },
          'invite',
        ),
      rejected(409),
    );
    for (const action of ['leave', 'subscribe'] as const) {
      const operation = { operationKey: key() };
      assert.deepEqual(
        f.comm.membership(
          f.agentPrincipal,
          f.teamId,
          channel.id,
          operation,
          action,
        ),
        f.comm.membership(
          f.agentPrincipal,
          f.teamId,
          channel.id,
          operation,
          action,
        ),
      );
    }
    assert.equal(
      f.comm.events(f.principal, f.teamId, channel.id).items.length,
      5,
    );
  } finally {
    await f.dispose();
  }
});

await test('snapshot keyset pagination has deterministic no-skip/no-duplicate history under concurrent inserts and rejects cross-view cursors', async () => {
  const f = await communicationFixture();
  try {
    f.invite();
    const topic = f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'Topic',
    });
    const original = Array.from({ length: 7 }, (_, i) =>
      f.comm.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({ body: String(i), topicId: topic.id }),
      ),
    );
    const first = f.comm.history(f.principal, f.teamId, f.channelId, {
      limit: 2,
    });
    assert.ok(first.nextCursor);
    const firstCursor = first.nextCursor;
    const ids = first.items.map((m) => m.id);
    const secondStore = f.open();
    try {
      secondStore.communication.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({ body: 'Concurrent' }),
      );
    } finally {
      secondStore.close();
    }
    let cursor: string | null = first.nextCursor;
    while (cursor !== null) {
      const page = f.comm.history(f.principal, f.teamId, f.channelId, {
        limit: 2,
        cursor,
      });
      ids.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
    }
    assert.deepEqual(
      ids,
      original.map((m) => m.id),
    );
    assert.equal(new Set(ids).size, 7);
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      8,
    );
    assert.throws(
      () =>
        f.comm.history(
          f.principal,
          f.teamId,
          f.channelId,
          { cursor: firstCursor },
          topic.id,
        ),
      rejected(400),
    );
    assert.throws(
      () =>
        f.comm.history(f.agentPrincipal, f.teamId, f.channelId, {
          cursor: firstCursor,
        }),
      rejected(400),
    );
    assert.throws(
      () =>
        f.comm.events(f.principal, f.teamId, f.channelId, {
          cursor: firstCursor,
        }),
      rejected(400),
    );
  } finally {
    await f.dispose();
  }
});

await test('channel/topic/outbox pages are bounded stable snapshots and new membership never bypasses fresh access checks', async () => {
  const f = await communicationFixture();
  try {
    for (let i = 0; i < 4; i++) {
      f.comm.createChannel(f.principal, f.teamId, {
        operationKey: key(),
        name: 'Channel ' + String(i),
      });
      f.comm.createTopic(f.principal, f.teamId, f.channelId, {
        operationKey: key(),
        title: 'Topic ' + String(i),
      });
    }
    const channels = f.comm.channels(f.principal, f.teamId, { limit: 2 });
    assert.ok(channels.nextCursor);
    f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'Later',
    });
    const rest = f.comm.channels(f.principal, f.teamId, {
      limit: 100,
      cursor: channels.nextCursor,
    });
    assert.equal(channels.items.length + rest.items.length, 5);
    const topics = f.comm.topics(f.principal, f.teamId, f.channelId, {
      limit: 2,
    });
    assert.ok(topics.nextCursor);
    f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'Later',
    });
    assert.equal(
      f.comm.topics(f.principal, f.teamId, f.channelId, {
        cursor: topics.nextCursor,
      }).items.length,
      2,
    );
    const events = f.comm.events(f.principal, f.teamId, f.channelId, {
      limit: 2,
    });
    assert.ok(events.nextCursor);
    const eventsCursor = events.nextCursor;
    f.comm.post(f.principal, f.teamId, f.channelId, postInput());
    assert.equal(
      f.comm.events(f.principal, f.teamId, f.channelId, {
        cursor: eventsCursor,
      }).items.length,
      4,
    );
    f.comm.membership(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    assert.throws(
      () =>
        f.comm.events(f.principal, f.teamId, f.channelId, {
          cursor: eventsCursor,
        }),
      rejected(404),
    );
    assert.equal(
      f.store.teamFor(f.owner.id)?.channels.some((c) => c.id === f.channelId),
      false,
    );
  } finally {
    await f.dispose();
  }
});

await test('outbox/mention/receipt failure rolls back messages and membership/channel/topic mutations in immediate transactions', async () => {
  const f = await communicationFixture();
  const raw = new Database(f.dbPath);
  try {
    f.invite();
    const before = f.comm.events(f.principal, f.teamId, f.channelId).items
      .length;
    raw.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON communication_outbox BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    const data = postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] });
    assert.throws(() => f.comm.post(f.principal, f.teamId, f.channelId, data));
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      0,
    );
    assert.equal(
      raw.prepare('SELECT count(*) FROM message_mentions').pluck().get(),
      0,
    );
    assert.throws(() =>
      f.comm.createTopic(f.principal, f.teamId, f.channelId, {
        operationKey: key(),
        title: 'Rollback',
      }),
    );
    assert.equal(
      f.comm.topics(f.principal, f.teamId, f.channelId).items.length,
      0,
    );
    const total = f.comm.channels(f.principal, f.teamId).items.length;
    assert.throws(() =>
      f.comm.createChannel(f.principal, f.teamId, {
        operationKey: key(),
        name: 'Rollback',
      }),
    );
    assert.equal(f.comm.channels(f.principal, f.teamId).items.length, total);
    assert.throws(() =>
      f.comm.membership(
        f.agentPrincipal,
        f.teamId,
        f.channelId,
        { operationKey: key() },
        'leave',
      ),
    );
    assert.equal(
      f.comm.participant(f.agentPrincipal, f.teamId, f.channelId).state,
      'joined',
    );
    raw.exec('DROP TRIGGER fail_outbox');
    const posted = f.comm.post(f.principal, f.teamId, f.channelId, data);
    assert.ok(posted.id);
    assert.equal(
      f.comm.events(f.principal, f.teamId, f.channelId).items.length,
      before + 1,
    );
    raw.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON communication_operations BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    assert.throws(() =>
      f.comm.post(f.principal, f.teamId, f.channelId, postInput()),
    );
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      1,
    );
    assert.equal(
      f.comm.events(f.principal, f.teamId, f.channelId).items.length,
      before + 1,
    );
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('revoked/disabled agent tokens and stale principals fail every channel/topic/history/message/mention/event read/write', async () => {
  const f = await communicationFixture();
  try {
    f.invite();
    const topic = f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'Topic',
    });
    const msg = f.comm.post(f.principal, f.teamId, f.channelId, postInput());
    f.store.agents.revoke(
      f.principal,
      f.teamId,
      f.agent.id,
      f.credential.grant.id,
    );
    const reads = [
      f.channelsPath,
      ...[
        '',
        '/membership',
        '/topics',
        '/topics/' + topic.id,
        '/topics/' + topic.id + '/messages',
        '/messages',
        '/messages/' + msg.id,
        '/messages/' + msg.id + '/mentions',
        '/events',
      ].map((p) => f.channelPath + p),
    ];
    for (const url of reads)
      assert.equal(
        (await f.app.inject({ url, headers: f.headers })).statusCode,
        401,
      );
    for (const [url, payload] of [
      [f.channelsPath, { operationKey: key(), name: 'Denied' }],
      [f.channelPath + '/messages', postInput()],
      [f.channelPath + '/topics', { operationKey: key(), title: 'No' }],
      [f.channelPath + '/subscribe', { operationKey: key() }],
      [f.channelPath + '/leave', { operationKey: key() }],
      [
        f.channelPath + '/participants/invite',
        { operationKey: key(), member: { kind: 'human', id: f.owner.id } },
      ],
      [
        f.channelPath + '/participants/remove',
        { operationKey: key(), member: { kind: 'human', id: f.owner.id } },
      ],
    ] as const)
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url,
            headers: f.headers,
            payload,
          })
        ).statusCode,
        401,
      );
    assert.throws(
      () => f.comm.history(f.agentPrincipal, f.teamId, f.channelId),
      rejected(401),
    );
    assert.throws(
      () => f.comm.post(f.agentPrincipal, f.teamId, f.channelId, postInput()),
      rejected(401),
    );
    const fresh = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
      label: 'Fresh',
      scopes: ['channels:read', 'channels:write'],
      lifetimeSeconds: 3600,
    });
    const headers = { authorization: 'Bearer ' + fresh.token };
    f.store.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'disabled');
    for (const url of reads)
      assert.equal((await f.app.inject({ url, headers })).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.channelPath + '/messages',
          headers,
          payload: postInput(),
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.dispose();
  }
});

await test('scope enforcement, actor spoofing, mixed human/agent authority and strict size/cursor schemas fail closed', async () => {
  const f = await communicationFixture();
  try {
    f.invite();
    const grant = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
      label: 'Read only',
      scopes: ['channels:read'],
      lifetimeSeconds: 3600,
    });
    const headers = { authorization: 'Bearer ' + grant.token };
    assert.equal(
      (await f.app.inject({ url: f.channelPath + '/messages', headers }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.channelPath + '/messages',
          headers,
          payload: postInput(),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          url: f.channelPath,
          headers: f.headers,
          cookies: f.cookies,
        })
      ).statusCode,
      400,
    );
    for (const url of [
      f.channelPath + '?actor=' + f.owner.id,
      f.channelPath + '?role=owner',
    ])
      assert.equal(
        (await f.app.inject({ url, headers: f.headers })).statusCode,
        400,
      );
    assert.equal(
      (
        await f.app.inject({
          url: f.channelPath,
          headers: { ...f.headers, 'x-kinmesh-actor': f.owner.id },
        })
      ).statusCode,
      400,
    );
    for (const payload of [
      { ...postInput(), author: { kind: 'human', humanId: f.owner.id } },
      { ...postInput(), body: 'x'.repeat(8001) },
      {
        ...postInput(),
        mentions: [
          { kind: 'agent', id: f.agent.id },
          { kind: 'agent', id: f.agent.id },
        ],
      },
      { ...postInput(), body: 'secret'.repeat(5000) },
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        headers: f.headers,
        payload,
      });
      assert.ok([400, 413].includes(response.statusCode));
      assert.equal(response.body.includes('secret'), false);
    }
    for (const query of [
      'limit=0',
      'limit=101',
      'cursor=not-a-cursor',
      'unknown=true',
    ])
      assert.equal(
        (
          await f.app.inject({
            url: f.channelPath + '/messages?' + query,
            headers: f.headers,
          })
        ).statusCode,
        400,
      );
    assert.equal(
      PostInput.safeParse({ ...postInput(), operationKey: 'invalid key' })
        .success,
      false,
    );
    const fact = f.comm.events(f.principal, f.teamId, f.channelId).items[0]
      ?.fact;
    assert.ok(fact);
    assert.equal(
      CommunicationFact.safeParse({
        ...fact,
        participant: { kind: 'agent', id: f.agent.id },
        participantState: null,
      }).success,
      false,
    );
    assert.equal(
      CommunicationFact.safeParse({ ...fact, sourceMessageId: randomUUID() })
        .success,
      false,
    );

    assert.equal(
      PageInput.safeParse({ cursor: 'x'.repeat(2049) }).success,
      false,
    );
  } finally {
    await f.dispose();
  }
});

await test('human nonowner team membership alone does not expose channels; owner invite grants scoped participation, not management', async () => {
  const f = await communicationFixture();
  const raw = new Database(f.dbPath);
  try {
    const id = HumanId.parse(randomUUID());
    const account = f.store.credentials('owner');
    assert.ok(account);
    raw
      .prepare('INSERT INTO humans VALUES (?, ?, ?)')
      .run(id, 'participant', account.passwordHash);
    raw
      .prepare('INSERT INTO memberships VALUES (?, ?, ?)')
      .run(id, f.teamId, 'member');
    const p: Principal = { kind: 'human', humanId: id };
    assert.equal(f.comm.channels(p, f.teamId).items.length, 0);
    assert.throws(
      () => f.comm.channel(p, f.teamId, f.channelId),
      rejected(404),
    );
    f.comm.enroll(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), member: { kind: 'human', id } },
      'invite',
    );
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: {
        username: 'participant',
        password: 'a long owner test password',
      },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies[0];
    assert.ok(cookie);
    const cookies = { [cookie.name]: cookie.value };
    assert.equal(
      (await f.app.inject({ url: f.channelPath + '/messages', cookies }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.channelPath + '/messages',
          cookies,
          payload: postInput(),
        })
      ).statusCode,
      201,
    );
    assert.throws(
      () =>
        f.comm.createChannel(p, f.teamId, {
          operationKey: key(),
          name: 'Escalate',
        }),
      rejected(403),
    );
    assert.throws(
      () =>
        f.comm.enroll(
          p,
          f.teamId,
          f.channelId,
          { operationKey: key(), member: { kind: 'agent', id: f.agent.id } },
          'invite',
        ),
      rejected(403),
    );
    const foreign = TeamId.parse(randomUUID());
    raw.prepare('INSERT INTO teams VALUES (?, ?)').run(foreign, 'Foreign');
    assert.throws(() => f.comm.channels(p, foreign), rejected(403));
    raw
      .prepare('INSERT INTO memberships VALUES (?, ?, ?)')
      .run(f.owner.id, foreign, 'owner');
    const foreignAgent = f.store.agents.create(
      f.principal,
      foreign,
      profileInput,
    );
    assert.throws(
      () =>
        f.comm.post(
          f.principal,
          f.teamId,
          f.channelId,
          postInput({ mentions: [{ kind: 'agent', id: foreignAgent.id }] }),
        ),
      rejected(404),
    );
    assert.throws(() =>
      f.comm.enroll(
        f.principal,
        f.teamId,
        f.channelId,
        {
          operationKey: key(),
          member: { kind: 'agent', id: foreignAgent.id },
        },
        'invite',
      ),
    );
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('service/DB reopen reconstructs full channel/topic history and mentions without an execution run; replay survives restart', async () => {
  const f = await communicationFixture();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    f.invite();
    const topic = f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'Persistent',
    });
    const input = postInput({
      topicId: topic.id,
      mentions: [{ kind: 'agent', id: f.agent.id }],
    });
    const first = f.comm.post(f.principal, f.teamId, f.channelId, input);
    f.comm.post(
      f.agentPrincipal,
      f.teamId,
      f.channelId,
      postInput({ topicId: topic.id, sourceMessageId: first.id }),
    );
    const expected = f.comm.history(f.principal, f.teamId, f.channelId);
    const facts = f.comm.events(f.principal, f.teamId, f.channelId);
    await f.app.close();
    const store = f.open();
    app = await createApp(f.config, store);
    const response = await app.inject({
      url: f.channelPath + '/messages',
      headers: f.headers,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(pageOf(Message).parse(response.json<unknown>()), expected);
    assert.deepEqual(
      store.communication.events(f.principal, f.teamId, f.channelId),
      facts,
    );
    assert.deepEqual(
      store.communication.post(f.principal, f.teamId, f.channelId, input),
      first,
    );
    assert.equal(
      store.agents.correlations(f.principal, f.teamId, f.agent.id).length,
      0,
    );
  } finally {
    if (app !== undefined) await app.close();
    await f.dispose();
  }
});

await test('late-invited agent reconstructs preexisting channel/topic history with no T3 execution or display-name mention parsing', async () => {
  const f = await communicationFixture();
  try {
    const topic = f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'Before subscription',
    });
    const message = f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ topicId: topic.id, body: '@Developer is only text' }),
    );
    assert.equal(message.mentions.length, 0);
    f.invite();
    const history = f.comm.history(f.agentPrincipal, f.teamId, f.channelId);
    assert.deepEqual(history.items, [message]);
    assert.equal(
      f.comm.history(f.agentPrincipal, f.teamId, f.channelId, {}, topic.id)
        .items[0]?.id,
      message.id,
    );
    assert.equal(
      f.store.agents.correlations(f.principal, f.teamId, f.agent.id).length,
      0,
    );
  } finally {
    await f.dispose();
  }
});
