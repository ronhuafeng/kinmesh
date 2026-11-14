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

await test('deterministic migrations enable WAL and foreign keys; the team survives reopen', () => {
  const f = fixture();
  try {
    const store = f.open();
    const created = store.signIn(feishuPerson('owner@example.com'));
    store.close();
    const reopened = f.open();
    assert.equal(reopened.teamFor(created.id)?.channels[0]?.name, 'general');
    assert.deepEqual(
      reopened.signIn(feishuPerson('owner@example.com')),
      created,
    );
    assert.equal(reopened.human(created.id)?.username, 'owner');
    // Whoever comes next joins that team; there is never a second.
    const other = reopened.signIn(feishuPerson('other@example.com'));
    assert.equal(
      reopened.teamFor(other.id)?.team.id,
      reopened.teamFor(created.id)?.team.id,
    );
    reopened.close();
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
await test('database rejects invalid role, orphan membership, duplicate channel, singleton and names', () => {
  const f = fixture();
  const store = f.open();
  try {
    const human = store.signIn(feishuPerson('owner@example.com'));
    const team = store.teamFor(human.id);
    assert.ok(team);
    const created = { human, team: team.team };
    const raw = new Database(f.path);
    raw.pragma('foreign_keys = ON');
    try {
      assert.throws(() =>
        raw
          .prepare('INSERT INTO memberships VALUES (?, ?, ?)')
          .run(created.human.id, 'missing', 'owner'),
      );
      assert.throws(() =>
        raw.prepare('UPDATE memberships SET role = ?').run('admin'),
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
      store.teamFor(HumanId.parse('00000000-0000-4000-8000-000000000000')),
      undefined,
    );
  } finally {
    store.close();
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
      const owner = recovered.signIn(feishuPerson('owner@example.com'));
      assert.equal(recovered.teamFor(owner.id)?.team.name, 'Committed team');
    } finally {
      recovered.close();
    }
  } finally {
    await stop(child, 'SIGKILL');
    f.cleanup();
  }
});
