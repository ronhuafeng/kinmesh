import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateTo } from './migration-helpers.js';
import { z } from 'zod';
import { openStore } from '../src/persistence/store.js';
import { inboxFixture } from './inbox-helpers.js';
import { postInput } from './communication-helpers.js';
await test('populated main/PR18 migration preserves every baseline row and active single-flight lease; no historical auto-dispatch', async () => {
  const f = await inboxFixture();
  let upgraded: ReturnType<typeof openStore> | undefined;
  const source = new Database(f.dbPath);
  const oldPath = join(f.directory, 'populated-main.sqlite');
  const old = new Database(oldPath);
  try {
    f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
    );
    f.create({ owner: { kind: 'agent', id: f.agent.id } });
    const operation = f.store.operations.prepare(
      'migration-fixture',
      { actor: 'migration-owner', operationKey: 'existing-flight' },
      't3_thread_launch',
      { scratch: true },
      'fixture-authority',
    );
    const lease = f.store.operations.claim(operation.id);
    assert.ok(lease);
    migrateTo(old, f.directory, 6);
    const names = z
      .array(z.object({ name: z.string() }))
      .parse(
        old
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
          )
          .all(),
      )
      .map((r) => r.name);
    old.pragma('foreign_keys=OFF');
    old.prepare('ATTACH DATABASE ? AS fixture_source').run(f.dbPath);
    for (const name of names) {
      assert.match(name, /^[a-z_]+$/);
      old.exec('INSERT INTO ' + name + ' SELECT * FROM fixture_source.' + name);
    }
    old.exec('DETACH DATABASE fixture_source');
    old.close();
    upgraded = openStore(oldPath);
    const after = new Database(oldPath);
    try {
      for (const name of names) {
        // The baseline had no mailbox; one arrives only from Feishu sign-in.
        const columns = name === 'humans' ? 'id, username' : '*';
        const read = `SELECT ${columns} FROM ${name} ORDER BY rowid`;
        assert.deepEqual(after.prepare(read).all(), source.prepare(read).all());
      }
      assert.deepEqual(upgraded.operations.get(operation.id), lease);
      assert.equal(upgraded.operations.claim(operation.id, true), undefined);
      assert.deepEqual(upgraded.inbox.status(), []);
      assert.deepEqual(after.pragma('foreign_key_check'), []);
      assert.equal(after.pragma('journal_mode', { simple: true }), 'wal');
    } finally {
      after.close();
    }
    const before = f.comm.history(f.principal, f.teamId, f.channelId);
    assert.deepEqual(
      upgraded.communication.history(f.principal, f.teamId, f.channelId),
      before,
    );
  } finally {
    if (old.open) old.close();
    upgraded?.close();
    source.close();
    await f.dispose();
  }
});
