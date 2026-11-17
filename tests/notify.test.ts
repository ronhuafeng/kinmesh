import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HumanId } from '../src/domain/contracts.js';
import { MessageId } from '../src/domain/communication.js';
import { payloadOf } from '../src/server/notify.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { communicationFixture, postInput } from './communication-helpers.js';
import { feishuPerson, signInAs } from './feishu.js';
import { rawDatabase } from './raw.js';
import { taskInput } from './task-helpers.js';

/** A browser's subscription, shaped as `PushSubscription.toJSON()` gives it. */
const browser = () => ({
  endpoint: 'https://push.example.test/' + randomUUID(),
  expirationTime: null,
  keys: {
    p256dh: 'B' + 'A'.repeat(86),
    auth: 'A'.repeat(22),
  },
});

await test('what concerns a person notifies them, at their level, and never their own act', async () => {
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await f.invite();
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const level = (cookies: typeof f.cookies, value: string) =>
      f.app.inject({
        method: 'PUT',
        url: '/api/me/notify',
        cookies,
        payload: { level: value },
      });
    const kinds = async (humanId: string) =>
      (
        await raw
          .prepare(
            'SELECT kind FROM notifications WHERE human_id = ? ORDER BY created_at, kind',
          )
          .pluck()
          .all(humanId)
      ).map(String);
    const post = async (
      as: 'owner' | 'agent',
      overrides: Parameters<typeof postInput>[0] = {},
    ) => {
      const posted = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        ...(as === 'owner' ? { cookies: f.cookies } : { headers: f.headers }),
        payload: postInput(overrides),
      });
      assert.equal(posted.statusCode, 201);
      return posted.json<{ id: string }>().id;
    };

    // At the default level an ordinary message notifies no one, and its
    // author never.
    await post('owner');
    assert.deepEqual(await kinds(grace.id), []);
    assert.deepEqual(await kinds(f.owner.id), []);

    // A mention notifies the person mentioned.
    await post('owner', { mentions: [{ kind: 'human', id: grace.id }] });
    assert.deepEqual(await kinds(grace.id), ['mention']);

    // Asking everything adds every message; nothing adds none.
    assert.equal((await level(graceCookies, 'all')).statusCode, 204);
    await post('owner');
    assert.deepEqual(await kinds(grace.id), ['mention', 'message']);
    assert.equal((await level(graceCookies, 'off')).statusCode, 204);
    await post('owner', { mentions: [{ kind: 'human', id: grace.id }] });
    assert.deepEqual(await kinds(grace.id), ['mention', 'message']);
    assert.equal(
      (await level(graceCookies, 'loud')).statusCode,
      400,
      'an unknown level is refused',
    );

    // An agent answering what the owner asked notifies the owner.
    const asked = await post('owner', {
      mentions: [{ kind: 'agent', id: f.agent.id }],
    });
    const event = String(
      await raw
        .prepare(
          "SELECT id FROM communication_outbox WHERE fact::jsonb ->> 'messageId' = ?",
        )
        .pluck()
        .get(asked),
    );
    await post('agent', {
      sourceMessageId: MessageId.parse(asked),
      sourceEventId: event,
    });
    assert.deepEqual(await kinds(f.owner.id), ['reply']);

    // A task handed to a person notifies them.
    assert.equal((await level(graceCookies, 'mine')).statusCode, 204);
    const created = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/tasks',
      cookies: f.cookies,
      payload: taskInput({
        owner: { kind: 'human', id: HumanId.parse(grace.id) },
      }),
    });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(await kinds(grace.id), ['mention', 'message', 'task']);

    // Each is due a little later, for an open tab to read it first.
    const due = await raw
      .prepare('SELECT due_at - created_at AS wait FROM notifications LIMIT 1')
      .get();
    assert.equal(Number(due?.wait), 5000);

    // The level is the person's own, shown in their snapshot.
    const snapshot = WorkspaceSnapshot.parse(
      (
        await f.app.inject({ url: '/api/workspace', cookies: graceCookies })
      ).json<unknown>(),
    );
    assert.equal(snapshot.notify, 'mine');
  } finally {
    await raw.close();
    await f.dispose();
  }
});

await test('a notification says who and where, and is dropped once read', async () => {
  const f = await communicationFixture();
  try {
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const posted = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: postInput({
        body: 'Please   look\nat this',
        mentions: [{ kind: 'human', id: grace.id }],
      }),
    });
    assert.equal(posted.statusCode, 201);
    const messageId = posted.json<{ id: string }>().id;
    // Due only once its wait is over.
    assert.deepEqual(await f.store.notifications.take(10), []);
    const raw = rawDatabase(f.dbPath);
    await raw.prepare('UPDATE notifications SET due_at = 0').run();
    await raw.close();
    const [n] = await f.store.notifications.take(10);
    assert.ok(n);
    assert.deepEqual(await f.store.notifications.take(10), [], 'taken once');
    const about = await f.store.notifications.describe(n);
    assert.ok(about);
    const payload = payloadOf(n, about);
    assert.equal(payload.kind, 'mention');
    const owner = await f.store.human(f.owner.id);
    assert.equal(payload.title, `${String(owner?.name)} · #general`);
    assert.equal(payload.body, 'Please look at this');
    assert.equal(payload.url, '/?channel=' + f.channelId);
    assert.equal(payload.tag, 'channel:' + f.channelId + ':');

    // Read since, it no longer concerns her.
    const read = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/read',
      cookies: graceCookies,
      payload: { messageId, topicId: null },
    });
    assert.equal(read.statusCode, 204);
    assert.equal(await f.store.notifications.describe(n), null);
  } finally {
    await f.dispose();
  }
});

await test('a browser notifies the person who turned it on, until they sign out of it', async () => {
  const f = await communicationFixture();
  try {
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const vapid = await f.app.inject({
      url: '/api/push/key',
      cookies: f.cookies,
    });
    assert.equal(vapid.statusCode, 200);
    assert.match(vapid.json<{ publicKey: string }>().publicKey, /^[\w-]{87}$/);

    const mine = browser();
    const subscribed = await f.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      cookies: f.cookies,
      payload: mine,
    });
    assert.equal(subscribed.statusCode, 204);
    assert.deepEqual(
      (await f.store.notifications.browsers(f.owner.id)).map((b) => b.endpoint),
      [mine.endpoint],
    );
    // Not a push service's address: refused.
    const plain = await f.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      cookies: f.cookies,
      payload: { ...mine, endpoint: 'http://push.example.test/x' },
    });
    assert.equal(plain.statusCode, 400);

    // Someone else can't take over a browser by renewing it.
    const renewed = await f.app.inject({
      method: 'POST',
      url: '/api/push/renew',
      cookies: graceCookies,
      payload: { endpoint: mine.endpoint },
    });
    assert.equal(renewed.statusCode, 204);
    assert.equal((await f.store.notifications.browsers(grace.id)).length, 0);
    assert.equal((await f.store.notifications.browsers(f.owner.id)).length, 1);

    // Signing out of the session that turned it on ends it.
    const out = await f.app.inject({
      method: 'POST',
      url: '/api/logout',
      cookies: f.cookies,
    });
    assert.equal(out.statusCode, 204);
    assert.equal((await f.store.notifications.browsers(f.owner.id)).length, 0);

    // Turned off from the browser: gone too.
    const hers = browser();
    await f.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      cookies: graceCookies,
      payload: hers,
    });
    const off = await f.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      cookies: graceCookies,
      payload: { endpoint: hers.endpoint },
    });
    assert.equal(off.statusCode, 204);
    assert.equal((await f.store.notifications.browsers(grace.id)).length, 0);

    // Agents have no browsers.
    const agent = await f.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      headers: f.headers,
      payload: browser(),
    });
    assert.equal(agent.statusCode, 403);
  } finally {
    await f.dispose();
  }
});

await test('muting silences a channel or an agent, never what waits on you; a pause silences everything', async () => {
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await f.invite();
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const kinds = async () =>
      (
        await raw
          .prepare(
            'SELECT kind FROM notifications WHERE human_id = ? ORDER BY created_at',
          )
          .pluck()
          .all(grace.id)
      ).map(String);
    const seen = async () =>
      WorkspaceSnapshot.parse(
        (
          await f.app.inject({ url: '/api/workspace', cookies: graceCookies })
        ).json<unknown>(),
      );
    const unread = async () =>
      (await seen()).latest.find((l) => l.channelId === f.channelId)?.unread;
    const post = async (as: 'owner' | 'agent') => {
      const posted = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        ...(as === 'owner' ? { cookies: f.cookies } : { headers: f.headers }),
        payload: postInput({ mentions: [{ kind: 'human', id: grace.id }] }),
      });
      assert.equal(posted.statusCode, 201);
    };
    // Everything she had seen is read: only what follows can be new.
    const latest = (await seen()).latest.find(
      (l) => l.channelId === f.channelId,
    );
    if (latest)
      await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/read',
        cookies: graceCookies,
        payload: { messageId: latest.messageId, topicId: null },
      });

    // A muted agent's mention neither notifies her nor makes the channel unread.
    const agentMute = `/api/teams/${f.teamId}/agents/${f.agent.id}/mute`;
    const muted = await f.app.inject({
      method: 'POST',
      url: agentMute,
      cookies: graceCookies,
      payload: { muted: true },
    });
    assert.equal(muted.statusCode, 204);
    await post('agent');
    assert.deepEqual(await kinds(), []);
    assert.equal(await unread(), false);
    // An agent can't mute anyone.
    const byAgent = await f.app.inject({
      method: 'POST',
      url: agentMute,
      headers: f.headers,
      payload: { muted: true },
    });
    assert.equal(byAgent.statusCode, 403);

    // A muted channel: a person's mention is silent and never unread.
    const channelMute = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/mute',
      cookies: graceCookies,
      payload: { muted: true },
    });
    assert.equal(channelMute.statusCode, 204);
    await post('owner');
    assert.deepEqual(await kinds(), []);
    assert.equal(await unread(), false);
    const quiet = await seen();
    assert.deepEqual(quiet.muted, {
      channels: [f.channelId],
      agents: [f.agent.id],
    });

    // What waits on her still notifies in a muted channel.
    const handed = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/tasks',
      cookies: f.cookies,
      payload: taskInput({
        owner: { kind: 'human', id: HumanId.parse(grace.id) },
      }),
    });
    assert.equal(handed.statusCode, 201);
    assert.deepEqual(await kinds(), ['task']);

    // Paused, nothing is sent, that included.
    const pause = (until: string | null) =>
      f.app.inject({
        method: 'PUT',
        url: '/api/me/pause',
        cookies: graceCookies,
        payload: { until },
      });
    assert.equal(
      (await pause(new Date(Date.now() - 1000).toISOString())).statusCode,
      400,
      'a pause in the past is refused',
    );
    assert.equal(
      (await pause(new Date(Date.now() + 8 * 86_400_000).toISOString()))
        .statusCode,
      400,
      'a pause of more than a week is refused',
    );
    assert.equal(
      (await pause(new Date(Date.now() + 3_600_000).toISOString())).statusCode,
      204,
    );
    assert.ok((await seen()).pausedUntil);
    await raw.prepare('UPDATE notifications SET due_at = 0').run();
    const [n] = await f.store.notifications.take(10);
    assert.ok(n);
    assert.equal(await f.store.notifications.describe(n), null);
    assert.equal((await pause(null)).statusCode, 204);
    assert.equal((await seen()).pausedUntil, null);

    // Unmuted, the channel turns unread again for what she hasn't read.
    await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/mute',
      cookies: graceCookies,
      payload: { muted: false },
    });
    assert.equal(await unread(), true);
  } finally {
    await raw.close();
    await f.dispose();
  }
});
