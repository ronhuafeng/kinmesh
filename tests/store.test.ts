import { test } from 'node:test';
import { forkWorker, message, stop } from './process-helpers.js';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './helpers.js';
import { feishuPerson } from './feishu.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { HumanId } from '../src/domain/contracts.js';

const journal = z
  .object({ entries: z.array(z.unknown()) })
  .parse(JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')));

await test('deterministic migrations enable WAL and foreign keys; the team survives reopen', async () => {
  const f = fixture();
  try {
    const store = f.open();
    const created = await store.signIn(feishuPerson('owner@example.com'));
    await store.close();
    const reopened = f.open();
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
    const raw = new Database(f.path);
    assert.equal(raw.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(
      raw
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
        .pluck()
        .get(),
      // Every migration in the journal is applied, whatever their number.
      journal.entries.length,
    );
    raw.close();
  } finally {
    f.cleanup();
  }
});
await test('database rejects orphan membership, duplicate channel, singleton and names', async () => {
  const f = fixture();
  const store = f.open();
  try {
    const human = await store.signIn(feishuPerson('owner@example.com'));
    const team = await store.teamFor(human.id);
    assert.ok(team);
    const created = { human, team: team.team };
    const raw = new Database(f.path);
    raw.pragma('foreign_keys = ON');
    try {
      assert.throws(() =>
        raw
          .prepare('INSERT INTO memberships VALUES (?, ?)')
          .run(created.human.id, 'missing'),
      );
      assert.throws(() =>
        raw
          .prepare('INSERT INTO channels VALUES (?, ?, ?)')
          .run('second', created.team.id, 'general'),
      );
      assert.throws(() =>
        raw.prepare('INSERT INTO bootstrap VALUES (?, ?)').run(2, 'now'),
      );
      assert.throws(() => raw.prepare('UPDATE teams SET name = ?').run(' '));
      assert.throws(() =>
        raw
          .prepare('INSERT INTO humans (id, username) VALUES (?, ?)')
          .run('second', 'owner'),
      );
      // One person per Feishu identity; a mailbox may pass to someone new.
      const identity = feishuPerson('owner@example.com').feishuId;
      assert.throws(() =>
        raw
          .prepare(
            'INSERT INTO humans (id, username, feishu_id) VALUES (?, ?, ?)',
          )
          .run('third', 'third', identity),
      );
      raw
        .prepare('INSERT INTO humans (id, username, email) VALUES (?, ?, ?)')
        .run('fourth', 'fourth', 'owner@example.com');
    } finally {
      raw.close();
    }
    assert.equal(
      await store.teamFor(
        HumanId.parse('00000000-0000-4000-8000-000000000000'),
      ),
      undefined,
    );
  } finally {
    await store.close();
    f.cleanup();
  }
});

await test('WAL recovers a committed team and discards an interrupted writer transaction', async () => {
  const f = fixture();
  const child = forkWorker(
    new URL('./fixtures/crash-writer.ts', import.meta.url),
    [f.path],
  );
  try {
    await message(child);
    await stop(child, 'SIGKILL');
    const recovered = f.open();
    try {
      const owner = await recovered.signIn(feishuPerson('owner@example.com'));
      assert.equal(
        (await recovered.teamFor(owner.id))?.team.name,
        'Committed team',
      );
    } finally {
      await recovered.close();
    }
  } finally {
    await stop(child, 'SIGKILL');
    f.cleanup();
  }
});
