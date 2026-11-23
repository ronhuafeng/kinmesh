import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { MessageId } from '../src/domain/communication.js';
import { communicationFixture, postInput } from './communication-helpers.js';

/**
 * A workspace snapshot is one consistent read: a single transaction, and a
 * number of queries that does not grow with the messages it shows.
 */
await test('a snapshot is one transaction whose queries do not grow with its messages', async () => {
  const f = await communicationFixture();
  try {
    await f.invite();
    const read = async () => {
      let body: unknown;
      const { transactions, queries } = await f.store.tally(async () => {
        const response = await f.app.inject({
          url: '/api/workspace',
          cookies: f.cookies,
        });
        assert.equal(response.statusCode, 200);
        body = response.json<unknown>();
      });
      return { snapshot: WorkspaceSnapshot.parse(body), transactions, queries };
    };
    const post = (body: string) =>
      f.store.messages.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({
          body,
          mentions: [
            { kind: 'agent', id: f.agent.id },
            { kind: 'human', id: f.owner.id },
          ],
        }),
      );
    await post('one');
    const few = await read();
    assert.equal(few.transactions, 1);
    for (let i = 0; i < 20; i++) await post(`more ${String(i)}`);
    const many = await read();
    assert.equal(many.transactions, 1);
    assert.equal(many.snapshot.messages.items.length, 21);
    // Messages and their mentions are read in a fixed number of queries.
    assert.equal(many.queries, few.queries);
  } finally {
    await f.dispose();
  }
});

await test('messages read together are each the message read alone, mentions in order', async () => {
  const f = await communicationFixture();
  try {
    await f.invite();
    for (let i = 0; i < 5; i++)
      await f.store.messages.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({
          body: `message ${String(i)}`,
          mentions:
            i % 2 === 0
              ? [
                  { kind: 'human', id: f.owner.id },
                  { kind: 'agent', id: f.agent.id },
                ]
              : [],
        }),
      );
    const page = await f.store.messages.history(
      f.principal,
      f.teamId,
      f.channelId,
    );
    assert.equal(page.items.length, 5);
    for (const item of page.items)
      assert.deepEqual(
        item,
        await f.store.messages.message(
          f.principal,
          f.teamId,
          f.channelId,
          MessageId.parse(item.id),
        ),
      );
    // The newest message of the channel is the history's newest.
    const latest = (await f.store.channels.latest(f.principal, f.teamId)).find(
      (l) => l.channelId === f.channelId,
    );
    assert.equal(latest?.messageId, page.items.at(-1)?.id);
  } finally {
    await f.dispose();
  }
});
