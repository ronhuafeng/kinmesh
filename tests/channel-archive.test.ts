import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { communicationFixture, postInput } from './communication-helpers.js';

const Snapshot = z.object({
  channels: z.object({
    items: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  archivedChannels: z.array(z.object({ id: z.string() })),
  channelArchived: z.boolean(),
  messages: z.object({ items: z.array(z.object({ body: z.string() })) }),
});

/**
 * Proves a channel is named again (a taken name refused) and archived: it
 * leaves the list, stays readable, takes nothing new, and comes back.
 */
await test('a channel is renamed and archived; archived, it is read but never written to, until brought back', async () => {
  const f = await communicationFixture();
  try {
    const call = (path: string, payload: object) =>
      f.app.inject({
        method: 'POST',
        url: f.channelPath + path,
        cookies: f.cookies,
        payload,
      });
    const read = async () =>
      Snapshot.parse(
        (
          await f.app.inject({
            method: 'GET',
            url: '/api/workspace?channelId=' + f.channelId,
            cookies: f.cookies,
          })
        ).json(),
      );
    assert.equal(
      (await call('/messages', postInput({ body: 'Before' }))).statusCode,
      201,
    );
    // Named again; a name the team uses is refused.
    const other = await f.app.inject({
      method: 'POST',
      url: f.channelsPath,
      cookies: f.cookies,
      payload: { operationKey: randomUUID(), name: 'taken' },
    });
    assert.equal(other.statusCode, 201);
    assert.equal(
      (await call('/rename', { operationKey: randomUUID(), name: 'taken' }))
        .statusCode,
      409,
    );
    const renamed = await call('/rename', {
      operationKey: randomUUID(),
      name: 'launch',
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json<{ name: string }>().name, 'launch');
    // Archived: out of the list, still read, nothing new.
    assert.equal(
      (await call('/archive', { operationKey: randomUUID(), archived: true }))
        .statusCode,
      200,
    );
    const archived = await read();
    assert.equal(archived.channelArchived, true);
    assert.ok(!archived.channels.items.some((c) => c.id === f.channelId));
    assert.deepEqual(
      archived.archivedChannels.map((c) => c.id),
      [f.channelId],
    );
    assert.deepEqual(
      archived.messages.items.map((m) => m.body),
      ['Before'],
    );
    assert.equal(
      (await call('/messages', postInput({ body: 'After' }))).statusCode,
      409,
    );
    // Brought back, it takes messages again.
    assert.equal(
      (await call('/archive', { operationKey: randomUUID(), archived: false }))
        .statusCode,
      200,
    );
    assert.equal((await read()).channelArchived, false);
    assert.equal(
      (await call('/messages', postInput({ body: 'After' }))).statusCode,
      201,
    );
  } finally {
    await f.dispose();
  }
});
