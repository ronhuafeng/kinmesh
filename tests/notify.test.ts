import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HumanId } from '../src/domain/contracts.js';
import { MessageId } from '../src/domain/communication.js';
import { payloadOf } from '../src/server/notify.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { communicationFixture, postInput } from './communication-helpers.js';
import { feishuPerson, signInAs, standInMessages } from './feishu.js';
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

await test('what concerns a person notifies them in channels they have not muted; every other message only where they follow', async () => {
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await f.invite();
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const level = (value: string) =>
      f.app.inject({
        method: 'POST',
        url: f.channelPath + '/level',
        cookies: graceCookies,
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
    const mentionGrace = {
      mentions: [{ kind: 'human' as const, id: grace.id }],
    };

    // At the default, an ordinary message notifies no one, and its author
    // never; a mention notifies the person mentioned.
    await post('owner');
    assert.deepEqual(await kinds(grace.id), []);
    assert.deepEqual(await kinds(f.owner.id), []);
    await post('owner', mentionGrace);
    assert.deepEqual(await kinds(grace.id), ['mention']);

    // Following the channel adds every message.
    assert.equal((await level('follow')).statusCode, 204);
    await post('owner');
    assert.deepEqual(await kinds(grace.id), ['mention', 'message']);

    // Muting it silences everything there, what concerns her included.
    assert.equal((await level('mute')).statusCode, 204);
    await post('owner', mentionGrace);
    const handed = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/tasks',
      cookies: f.cookies,
      payload: taskInput({
        owner: { kind: 'human', id: HumanId.parse(grace.id) },
      }),
    });
    assert.equal(handed.statusCode, 201);
    assert.deepEqual(await kinds(grace.id), ['mention', 'message']);
    assert.equal((await level('loud')).statusCode, 400, 'an unknown level');
    const muted = WorkspaceSnapshot.parse(
      (
        await f.app.inject({ url: '/api/workspace', cookies: graceCookies })
      ).json<unknown>(),
    );
    assert.deepEqual(muted.levels, [{ channelId: f.channelId, level: 'mute' }]);
    assert.equal(
      muted.latest.find((l) => l.channelId === f.channelId)?.unread,
      false,
      'a muted channel is never unread',
    );

    // Back at the default, a task handed to her notifies her.
    assert.equal((await level('default')).statusCode, 204);
    const again = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/tasks',
      cookies: f.cookies,
      payload: taskInput({
        owner: { kind: 'human', id: HumanId.parse(grace.id) },
      }),
    });
    assert.equal(again.statusCode, 201);
    assert.deepEqual(await kinds(grace.id), ['mention', 'message', 'task']);

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

    // Each is due a little later, for an open tab to read it first.
    const due = await raw
      .prepare('SELECT due_at - created_at AS wait FROM notifications LIMIT 1')
      .get();
    assert.equal(Number(due?.wait), 5000);
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

    // A test goes only to a browser that notifies the caller now: one
    // turned off is gone (410); one whose push service can't be reached
    // says so (502).
    const test = (endpoint: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/push/test',
        cookies: graceCookies,
        payload: { endpoint },
      });
    assert.equal((await test(hers.endpoint)).statusCode, 410);
    const unreachable = browser();
    await f.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      cookies: graceCookies,
      payload: unreachable,
    });
    assert.equal((await test(unreachable.endpoint)).statusCode, 502);
    // The owner signed out above: signed in again, Grace's browser is still
    // not theirs to test.
    const ownerAgain = await signInAs(f.app, 'owner@example.com');
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/push/test',
          cookies: ownerAgain,
          payload: { endpoint: unreachable.endpoint },
        })
      ).statusCode,
      410,
      "someone else's browser is not theirs to test",
    );

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

await test('while a person is in Kinmesh it shows a notice instead; in their quiet time it holds, then sends one summary', async () => {
  standInMessages.length = 0;
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const mention = async () => {
      const posted = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        cookies: f.cookies,
        payload: postInput({ mentions: [{ kind: 'human', id: grace.id }] }),
      });
      assert.equal(posted.statusCode, 201);
    };
    const state = async () =>
      String(
        await raw
          .prepare(
            'SELECT state FROM notifications WHERE human_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .pluck()
          .get(grace.id),
      );

    // She is here (her session was just used): a notice on her page, in
    // her snapshot, not a push.
    await mention();
    await raw.prepare('UPDATE notifications SET due_at = 0').run();
    await until(async () => (await state()) === 'inapp');
    const here = WorkspaceSnapshot.parse(
      (
        await f.app.inject({ url: '/api/workspace', cookies: graceCookies })
      ).json<unknown>(),
    );
    assert.equal(here.notices.length, 1);
    assert.match(here.notices[0]?.url ?? '', /^\/\?channel=/);

    // Paused: what falls due is held, not pushed, not dropped.
    const pause = await f.app.inject({
      method: 'PUT',
      url: '/api/me/pause',
      cookies: graceCookies,
      payload: { until: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(pause.statusCode, 204);
    await raw
      .prepare(
        // Two minutes ago: away from Kinmesh, still signed in.
        'UPDATE sessions SET last_seen_at = (extract(epoch from now()) * 1000)::bigint - 120000 WHERE human_id = ?',
      )
      .run(grace.id);
    await mention();
    await mention();
    await raw
      .prepare("UPDATE notifications SET due_at = 0 WHERE state = 'pending'")
      .run();
    await until(
      async () =>
        Number(
          await raw
            .prepare("SELECT count(*) FROM notifications WHERE state = 'held'")
            .pluck()
            .get(),
        ) === 2,
    );
    assert.equal(standInMessages.length, 0);

    // When it ends, one summary of what still waits, to Feishu (on by
    // default), and nothing held is left.
    await raw
      .prepare('UPDATE memberships SET paused_until = NULL WHERE human_id = ?')
      .run(grace.id);
    await until(() => Promise.resolve(standInMessages.length > 0));
    assert.equal(standInMessages.length, 1);
    assert.match(standInMessages[0]?.title ?? '', /有 2 件事等你/);
    assert.equal(
      Number(
        await raw
          .prepare("SELECT count(*) FROM notifications WHERE state = 'held'")
          .pluck()
          .get(),
      ),
      0,
    );
  } finally {
    await raw.close();
    await f.dispose();
  }
});

/** Until `check` holds, looking again as soon as the hub's sender may have run. */
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('never happened');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

await test('what stays unread goes to Feishu after the delay; nothing goes once read or turned off', async () => {
  standInMessages.length = 0;
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const forward = (minutes: number | null) =>
      f.app.inject({
        method: 'PUT',
        url: '/api/me/forward',
        cookies: graceCookies,
        payload: { minutes },
      });
    assert.equal((await forward(7)).statusCode, 400, 'only 0, 10 or never');
    assert.equal((await forward(10)).statusCode, 204);
    // Away from Kinmesh: her session last used long ago.
    const away = () =>
      raw
        .prepare(
          // Two minutes ago: away from Kinmesh, still signed in.
          'UPDATE sessions SET last_seen_at = (extract(epoch from now()) * 1000)::bigint - 120000 WHERE human_id = ?',
        )
        .run(grace.id);
    const mention = async (body: string) => {
      const posted = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        cookies: f.cookies,
        payload: postInput({
          body,
          mentions: [{ kind: 'human', id: grace.id }],
        }),
      });
      assert.equal(posted.statusCode, 201);
      return posted.json<{ id: string }>().id;
    };
    await mention('Can you look?');
    const wait = await raw
      .prepare('SELECT forward_at - created_at AS wait FROM notifications')
      .get();
    assert.equal(Number(wait?.wait), 5000 + 10 * 60_000);
    // Its time come, it goes to her in Feishu, once, with a link to it.
    await away();
    await raw.prepare('UPDATE notifications SET forward_at = 0').run();
    await until(() => Promise.resolve(standInMessages.length > 0));
    assert.equal(standInMessages.length, 1);
    const sent = standInMessages[0];
    assert.ok(sent);
    assert.equal(sent.union, feishuPerson('grace@example.com').feishuId);
    assert.equal(sent.text, 'Can you look?');
    assert.match(sent.url, /\/\?channel=/);

    // Read first, nothing goes.
    const read = await mention('Already seen');
    await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/read',
      cookies: graceCookies,
      payload: { messageId: read, topicId: null },
    });
    // Turned off after it was recorded, nothing goes either.
    await mention('Turned off since');
    assert.equal((await forward(null)).statusCode, 204);
    await raw
      .prepare(
        'UPDATE notifications SET forward_at = 0 WHERE forward_at IS NOT NULL',
      )
      .run();
    await until(
      async () =>
        Number(
          await raw
            .prepare(
              'SELECT count(*) FROM notifications WHERE forward_at IS NOT NULL',
            )
            .pluck()
            .get(),
        ) === 0,
    );
    assert.equal(standInMessages.length, 1);
    assert.equal((await forward(0)).statusCode, 204);
    const snapshot = WorkspaceSnapshot.parse(
      (
        await f.app.inject({ url: '/api/workspace', cookies: graceCookies })
      ).json<unknown>(),
    );
    assert.equal(snapshot.forwardAfter, 0);
  } finally {
    await raw.close();
    await f.dispose();
  }
});

await test("outside a person's hours a notification waits for them to open; a bad window is refused", async () => {
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    const graceCookies = await signInAs(f.app, 'grace@example.com');
    const grace = await f.store.signIn(feishuPerson('grace@example.com'));
    const hours = (value: unknown) =>
      f.app.inject({
        method: 'PUT',
        url: '/api/me/hours',
        cookies: graceCookies,
        payload: { hours: value },
      });
    // A window that opens two hours from now, in UTC.
    const now = new Date();
    const from = ((now.getUTCHours() + 2) % 24) * 60;
    const to = ((now.getUTCHours() + 3) % 24) * 60;
    assert.equal(
      (await hours({ from, to: from, weekdays: false, timeZone: 'UTC' }))
        .statusCode,
      400,
      'an empty window is refused',
    );
    assert.equal(
      (await hours({ from, to, weekdays: false, timeZone: 'Mars/Base' }))
        .statusCode,
      400,
      'an unknown time zone is refused',
    );
    assert.equal(
      (await hours({ from, to, weekdays: false, timeZone: 'UTC' })).statusCode,
      204,
    );
    const posted = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: postInput({ mentions: [{ kind: 'human', id: grace.id }] }),
    });
    assert.equal(posted.statusCode, 201);
    await raw.prepare('UPDATE notifications SET due_at = 0').run();
    // The sender takes it, finds her hours closed, and holds it for when
    // they open (a summary then), neither pushed nor dropped.
    await until(
      async () =>
        String(
          await raw.prepare('SELECT state FROM notifications').pluck().get(),
        ) === 'held',
    );
    const snapshot = WorkspaceSnapshot.parse(
      (
        await f.app.inject({ url: '/api/workspace', cookies: graceCookies })
      ).json<unknown>(),
    );
    assert.deepEqual(snapshot.hours, {
      from,
      to,
      weekdays: false,
      timeZone: 'UTC',
    });
  } finally {
    await raw.close();
    await f.dispose();
  }
});
