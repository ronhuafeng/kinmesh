import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  communicationFixture,
  key,
  postInput,
} from './communication-helpers.js';
import { rawDatabase } from './raw.js';

const Shown = z.object({
  id: z.string(),
  body: z.string(),
  editedAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
});

/**
 * Proves only a message's author changes or withdraws it, what it said
 * before is kept, a withdrawal is final and leaves search, and neither
 * wakes or tells anyone nor changes what was delivered from it.
 */
await test('a person edits and withdraws their own message; the record keeps what it said', async () => {
  const f = await communicationFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await f.invite();
    const posted = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      cookies: f.cookies,
      payload: postInput({
        body: 'Ship on Monday',
        mentions: [{ kind: 'agent', id: f.agent.id }],
      }),
    });
    assert.equal(posted.statusCode, 201);
    const id = posted.json<{ id: string }>().id;
    const delivered = await raw
      .prepare(
        'SELECT count(*)::int AS n FROM agent_inbox WHERE message_id = ?',
      )
      .pluck()
      .get(id);
    const agents = await f.app.inject({
      method: 'POST',
      url: f.channelPath + '/messages',
      headers: f.headers,
      payload: postInput({ body: 'On it' }),
    });
    assert.equal(agents.statusCode, 201);
    // What these told is told; from here on, nothing more is.
    await f.store.notifications.take(10);
    const change = (
      what: 'edit' | 'withdraw',
      payload: Record<string, unknown>,
      as: {
        cookies?: Record<string, string>;
        headers?: Record<string, string>;
      } = {
        cookies: f.cookies,
      },
      messageId = id,
    ) =>
      f.app.inject({
        method: 'POST',
        url: `${f.channelPath}/messages/${messageId}/${what}`,
        ...as,
        payload: { operationKey: key(), ...payload },
      });

    const edited = await change('edit', { body: 'Ship on Tuesday' });
    assert.equal(edited.statusCode, 200);
    const shown = Shown.parse(edited.json());
    assert.equal(shown.body, 'Ship on Tuesday');
    assert.ok(shown.editedAt);
    assert.equal(shown.withdrawnAt, null);
    // Saying the same again changes nothing; text can't go without files.
    assert.equal(
      Shown.parse((await change('edit', { body: 'Ship on Tuesday' })).json())
        .editedAt,
      shown.editedAt,
    );
    assert.equal((await change('edit', { body: '  ' })).statusCode, 400);

    // Only its author: not an agent, not on someone else's message.
    assert.equal(
      (await change('edit', { body: 'Mine now' }, { headers: f.headers }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await change(
          'edit',
          { body: 'Not on it' },
          undefined,
          agents.json<{ id: string }>().id,
        )
      ).statusCode,
      403,
    );

    const withdrawn = await change('withdraw', {});
    assert.equal(withdrawn.statusCode, 200);
    assert.equal(Shown.parse(withdrawn.json()).body, '');
    assert.ok(Shown.parse(withdrawn.json()).withdrawnAt);
    // Neither an edit nor a withdrawal wakes or tells anyone.
    assert.deepEqual(await f.store.notifications.take(10), []);
    assert.equal(
      await raw
        .prepare(
          'SELECT count(*)::int AS n FROM agent_inbox WHERE message_id = ?',
        )
        .pluck()
        .get(id),
      delivered,
    );
    // Final: nothing changes it after.
    assert.equal((await change('edit', { body: 'Back' })).statusCode, 409);
    assert.equal((await change('withdraw', {})).statusCode, 409);

    // What it said is kept, in order; search no longer finds it.
    assert.deepEqual(
      await raw
        .prepare(
          'SELECT kind, previous_body AS "previousBody", edited_by AS "editedBy" FROM message_edits WHERE message_id = ? ORDER BY position',
        )
        .all(id),
      [
        { kind: 'edit', previousBody: 'Ship on Monday', editedBy: f.owner.id },
        {
          kind: 'withdraw',
          previousBody: 'Ship on Tuesday',
          editedBy: f.owner.id,
        },
      ],
    );
    const found = await f.app.inject({
      method: 'GET',
      url: `/api/teams/${f.teamId}/search?q=Tuesday`,
      cookies: f.cookies,
    });
    assert.deepEqual(found.json<{ messages: unknown[] }>().messages, []);
    // Below the code too: who said it, and where, never change.
    await assert.rejects(
      raw.prepare("UPDATE messages SET author = 'x' WHERE id = ?").run(id),
      /immutable communication fact/,
    );
    await assert.rejects(
      raw.prepare('DELETE FROM messages WHERE id = ?').run(id),
      /immutable communication fact/,
    );
  } finally {
    await raw.close();
    await f.dispose();
  }
});
