import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  WorkspaceSnapshot,
  decodeExecutionEvent,
} from '../src/workspace/contracts.js';
import { Revisions } from '../src/workspace/events.js';
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
  const next = async (): Promise<Revisions | null> => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!/^event: revisions$/m.test(block)) continue;
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
        return Revisions.parse(JSON.parse(data) as unknown);
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return {
    /** The next `revisions` event, or null once the hub ends the stream. */
    next,
    /** Reads to the end; true once the hub has ended the stream. */
    async ended() {
      while ((await next()) !== null);
      return true;
    },
  };
}

await test(
  'a stream names the revision of each resource a view shows, then only what changed',
  { timeout: 30_000 },
  async () => {
    const f = await communicationFixture();
    const other = f.open();
    try {
      await f.app.listen({ host: '127.0.0.1', port: 0 });
      const address = f.app.server.address();
      assert.ok(address && typeof address === 'object');
      const origin = 'http://127.0.0.1:' + String(address.port);
      const cookie = Object.entries(f.cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('; ');
      const get = async (url: string) =>
        (await f.app.inject({ url, cookies: f.cookies })).json<unknown>();
      const workspace = async () =>
        WorkspaceSnapshot.parse(await get('/api/workspace')).revision;
      const t3 = async () =>
        z
          .object({ revision: z.string() })
          .parse(await get(`/api/teams/${f.teamId}/t3`)).revision;
      const runs = async () =>
        decodeExecutionEvent(await get(`/api/agui/${f.teamId}/${f.agent.id}`))
          .revision;
      const grants = async () =>
        z.object({ revision: z.string() }).parse(await get(f.path + '/grants'))
          .revision;
      const post = async (body: string) => {
        const posted = await f.app.inject({
          method: 'POST',
          url: f.channelPath + '/messages',
          cookies: f.cookies,
          payload: postInput({ body }),
        });
        assert.equal(posted.statusCode, 201);
      };

      // Only a signed-in person gets a stream, and only for a known page.
      assert.equal((await fetch(origin + '/api/events')).status, 401);
      for (const page of ['task:' + f.agent.id, 'agent:', 'agent'])
        assert.equal(
          (
            await fetch(origin + '/api/events?page=' + page, {
              headers: { cookie },
            })
          ).status,
          400,
        );

      // A channel view watches the workspace: named first, then on change.
      const place = await stream(origin, cookie);
      assert.deepEqual(await place.next(), { workspace: await workspace() });
      await post('Pushed, not polled');
      assert.deepEqual(await place.next(), { workspace: await workspace() });
      // Another process writes: the agent's worker starts.
      await other.inbox.heartbeat([f.agent.id]);
      assert.deepEqual(await place.next(), { workspace: await workspace() });
      // A later heartbeat changes nothing on screen.
      const awake = await workspace();
      await other.inbox.heartbeat([f.agent.id]);
      assert.equal(await workspace(), awake);

      // An agent page also watches T3 and the agent's runs.
      const agent = await stream(origin, cookie, 'page=agent:' + f.agent.id);
      assert.deepEqual(await agent.next(), {
        workspace: await workspace(),
        t3: await t3(),
        runs: await runs(),
      });
      // The page for running its worker yourself watches its credentials.
      const worker = await stream(origin, cookie, 'page=worker:' + f.agent.id);
      assert.deepEqual(await worker.next(), {
        workspace: await workspace(),
        grants: await grants(),
      });
      // A new run is named as such.
      await f.execution();
      const ran = await agent.next();
      assert.equal(ran?.runs, await runs());
      // A credential revoked elsewhere is named as such.
      const revoked = await f.app.inject({
        method: 'POST',
        url: `${f.path}/grants/${f.grant.grant.id}/revoke`,
        cookies: f.cookies,
      });
      assert.equal(revoked.statusCode, 204);
      assert.deepEqual(await worker.next(), { grants: await grants() });
      // A message changes the workspace alone.
      await post('Only the workspace');
      assert.deepEqual(await agent.next(), { workspace: await workspace() });

      // Streams are bounded per person.
      const more = [];
      for (let i = 0; i < 5; i++) more.push(await stream(origin, cookie));
      assert.equal(
        (await fetch(origin + '/api/events', { headers: { cookie } })).status,
        429,
      );

      // Signing out everywhere ends every stream of the session at once.
      const ended = await f.app.inject({
        method: 'POST',
        url: '/api/me/sessions/end',
        cookies: f.cookies,
      });
      assert.equal(ended.statusCode, 204);
      for (const s of [place, agent, worker, ...more])
        assert.ok(await s.ended());
    } finally {
      await other.close();
      await f.dispose();
    }
  },
);
