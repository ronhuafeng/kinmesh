import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { communicationFixture } from './communication-helpers.js';
import { signInAs, standInMessages } from './feishu.js';

const Sessions = z.array(
  z.object({ id: z.string(), current: z.boolean(), lastSeenAt: z.string() }),
);
const Browsers = z.array(z.object({ id: z.string(), service: z.string() }));

await test('your settings read you as Feishu gives you, and your sessions and browsers, each yours to end', async () => {
  standInMessages.length = 0;
  const f = await communicationFixture();
  try {
    // The profile: as Feishu gave it, and the team.
    const profile = await f.app.inject({
      url: '/api/me/profile',
      cookies: f.cookies,
    });
    assert.equal(profile.statusCode, 200);
    const me = profile.json<{
      username: string;
      email: string;
      team: string;
    }>();
    assert.equal(me.email, 'owner@example.com');
    assert.ok(me.team.length > 0);

    // A second sign-in is a second session; each is named by a short id,
    // and the one asking knows itself.
    const other = await signInAs(f.app, 'owner@example.com');
    const listed = Sessions.parse(
      (
        await f.app.inject({ url: '/api/me/sessions', cookies: f.cookies })
      ).json<unknown>(),
    );
    assert.equal(listed.length, 2);
    assert.equal(listed.filter((s) => s.current).length, 1);
    const elsewhere = listed.find((s) => !s.current);
    assert.ok(elsewhere);
    assert.match(elsewhere.id, /^[\w-]{16}$/);
    // Ending the other one ends it; an unknown id ends nothing.
    const end = (id: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/me/session/end',
        cookies: f.cookies,
        payload: { id },
      });
    assert.equal((await end(elsewhere.id)).statusCode, 204);
    assert.equal((await end('x'.repeat(16))).statusCode, 404);
    const gone = await f.app.inject({ url: '/api/workspace', cookies: other });
    assert.equal(gone.statusCode, 401);

    // A browser receiving notifications is listed by its push service,
    // never its endpoint, and can be removed by its id.
    const endpoint = 'https://push.example.test/' + randomUUID();
    await f.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      cookies: f.cookies,
      payload: {
        endpoint,
        expirationTime: null,
        keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) },
      },
    });
    const browsers = await f.app.inject({
      url: '/api/push/browsers',
      cookies: f.cookies,
    });
    assert.ok(!browsers.body.includes(endpoint), 'the endpoint never leaves');
    const [browser] = Browsers.parse(browsers.json<unknown>());
    assert.equal(browser?.service, 'push.example.test');
    const forget = await f.app.inject({
      method: 'POST',
      url: '/api/push/forget',
      cookies: f.cookies,
      payload: { id: browser.id },
    });
    assert.equal(forget.statusCode, 204);
    assert.equal((await f.store.notifications.browsers(f.owner.id)).length, 0);

    // The team's bot can be tried: it messages the person who asks.
    const tried = await f.app.inject({
      method: 'POST',
      url: '/api/feishu/test',
      cookies: f.cookies,
      payload: {},
    });
    assert.equal(tried.statusCode, 204);
    assert.equal(standInMessages.length, 1);

    // These are a person's own; an agent is refused.
    const agent = await f.app.inject({
      url: '/api/me/profile',
      headers: f.headers,
    });
    assert.equal(agent.statusCode, 403);
  } finally {
    await f.dispose();
  }
});
