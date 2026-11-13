import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { communicationFixture, postInput } from './communication-helpers.js';

/** One open `GET /api/events` stream, read event by event. */
async function stream(origin: string, cookie: string, query = '') {
  const response = await fetch(origin + '/api/events?' + query, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /^text\/event-stream/,
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    /** The next event's name, or null once the hub ends the stream. */
    async next(): Promise<string | null> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          if (name) return name;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

await test(
  'the hub says when what a view shows has changed, and only then',
  {
    timeout: 30_000,
  },
  async () => {
    const f = await communicationFixture();
    const other = f.open();
    try {
      await f.app.listen({ host: '127.0.0.1', port: 0 });
      const address = f.app.server.address();
      assert.ok(address && typeof address === 'object');
      const origin = 'http://127.0.0.1:' + String(address.port);
      const cookie = Object.entries(f.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
      const revision = async () =>
        WorkspaceSnapshot.parse(
          (
            await f.app.inject({ url: '/api/workspace', cookies: f.cookies })
          ).json<unknown>(),
        ).revision;

      // Only a signed-in person gets a stream.
      assert.equal((await fetch(origin + '/api/events')).status, 401);

      const first = await revision();
      const events = await stream(origin, cookie, 'since=' + first);
      // A write by the hub itself.
      const posted = await f.app.inject({
        method: 'POST',
        url: f.channelPath + '/messages',
        cookies: f.cookies,
        payload: postInput({ body: 'Pushed, not polled' }),
      });
      assert.equal(posted.statusCode, 201);
      assert.equal(await events.next(), 'changed');
      const second = await revision();
      assert.notEqual(second, first);

      // A write by another process: the agent's worker starts.
      other.inbox.heartbeat([f.agent.id]);
      assert.equal(await events.next(), 'changed');
      const awake = await revision();
      assert.notEqual(awake, second);
      // A later heartbeat changes nothing on screen.
      other.inbox.heartbeat([f.agent.id]);
      assert.equal(await revision(), awake);

      // A view opened with an older snapshot hears at once that it is behind.
      const behind = await stream(origin, cookie, 'since=' + first);
      assert.equal(await behind.next(), 'changed');

      // Streams are bounded per person.
      const more = [];
      for (let i = 0; i < 6; i++) more.push(await stream(origin, cookie));
      assert.equal(
        (await fetch(origin + '/api/events', { headers: { cookie } })).status,
        429,
      );

      // A changed password ends every stream of the old session at once.
      const changed = await f.app.inject({
        method: 'POST',
        url: '/api/me/password',
        cookies: f.cookies,
        payload: {
          currentPassword: 'a long owner test password',
          newPassword: 'another long owner test password',
        },
      });
      assert.equal(changed.statusCode, 204);
      assert.equal(await events.next(), null);
      assert.equal(await behind.next(), null);
      for (const s of more) assert.equal(await s.next(), null);
    } finally {
      other.close();
      await f.dispose();
    }
  },
);
