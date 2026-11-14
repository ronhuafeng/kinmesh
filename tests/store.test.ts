import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawDatabase } from './raw.js';
import { fixture } from './helpers.js';
import { feishuPerson } from './feishu.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { HumanId } from '../src/domain/contracts.js';

const journal = z
  .object({ entries: z.array(z.unknown()) })
  .parse(JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')));

await test('migrations are applied in full and the team survives reopen', async () => {
  const f = await fixture();
  try {
    const store = await f.open();
    const created = await store.signIn(feishuPerson('owner@example.com'));
    await store.close();
    const reopened = await f.open();
    assert.equal(
      (await reopened.teamFor(created.id))?.channels[0]?.name,
      'general',
    );
    assert.deepEqual(
      await reopened.signIn(feishuPerson('owner@example.com')),
      created,
    );
    assert.equal((await reopened.human(created.id))?.username, 'owner');
    // Whoever comes next joins that team; there is never a second.
    const other = await reopened.signIn(feishuPerson('other@example.com'));
    assert.equal(
      (await reopened.teamFor(other.id))?.team.id,
      (await reopened.teamFor(created.id))?.team.id,
    );
    await reopened.close();
    const raw = rawDatabase(f.path);
    assert.equal(
      await raw
        .prepare('SELECT count(*) AS n FROM drizzle.__drizzle_migrations')
        .pluck()
        .get(),
      // Every migration in the journal is applied, whatever their number.
      journal.entries.length,
    );
    await raw.close();
  } finally {
    await f.cleanup();
  }
});
await test('database rejects orphan membership, duplicate channel, singleton and names', async () => {
  const f = await fixture();
  const store = await f.open();
  try {
    const human = await store.signIn(feishuPerson('owner@example.com'));
    const team = await store.teamFor(human.id);
    assert.ok(team);
    const created = { human, team: team.team };
    const raw = rawDatabase(f.path);
    await raw.pragma('foreign_keys = ON');
    try {
      await assert.rejects(() =>
        raw
          .prepare('INSERT INTO memberships VALUES (?, ?)')
          .run(created.human.id, 'missing'),
      );
      await assert.rejects(() =>
        raw
          .prepare('INSERT INTO channels VALUES (?, ?, ?)')
          .run('second', created.team.id, 'general'),
      );
      await assert.rejects(() =>
        raw.prepare('INSERT INTO bootstrap VALUES (?, ?)').run(2, 'now'),
      );
      await assert.rejects(() =>
        raw.prepare('UPDATE teams SET name = ?').run(' '),
      );
      await assert.rejects(() =>
        raw
          .prepare('INSERT INTO humans (id, username) VALUES (?, ?)')
          .run('second', 'owner'),
      );
      // One person per Feishu identity; a mailbox may pass to someone new.
      const identity = feishuPerson('owner@example.com').feishuId;
      await assert.rejects(() =>
        raw
          .prepare(
            'INSERT INTO humans (id, username, feishu_id) VALUES (?, ?, ?)',
          )
          .run('third', 'third', identity),
      );
      await raw
        .prepare('INSERT INTO humans (id, username, email) VALUES (?, ?, ?)')
        .run('fourth', 'fourth', 'owner@example.com');
    } finally {
      await raw.close();
    }
    assert.equal(
      await store.teamFor(
        HumanId.parse('00000000-0000-4000-8000-000000000000'),
      ),
      undefined,
    );
  } finally {
    await store.close();
    await f.cleanup();
  }
});
