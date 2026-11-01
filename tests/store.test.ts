import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './helpers.js';
import { HumanId } from '../src/domain/contracts.js';

await test('deterministic migrations enable WAL and foreign keys; bootstrap survives reopen', () => {
  const f = fixture();
  try {
    const store = f.open();
    const created = store.bootstrap(
      'owner',
      'test-hash-not-a-real-password',
      'First team',
    );
    assert.equal(store.isBootstrapped(), true);
    store.close();
    const reopened = f.open();
    assert.equal(reopened.isBootstrapped(), true);
    assert.equal(
      reopened.teamFor(created.human.id)?.channels[0]?.name,
      'general',
    );
    assert.equal(reopened.credentials('owner')?.id, created.human.id);
    assert.equal(reopened.human(created.human.id)?.username, 'owner');
    assert.throws(() => reopened.bootstrap('other', 'hash', 'Another team'));
    assert.equal(reopened.credentials('other'), undefined);
    reopened.close();
    const raw = new Database(f.path);
    assert.equal(raw.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(
      raw
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
        .pluck()
        .get(),
      9,
    );
    raw.close();
  } finally {
    f.cleanup();
  }
});
await test('bootstrap rollback removes all partial team state and permits retry', () => {
  const f = fixture();
  const store = f.open();
  try {
    assert.throws(() => store.bootstrap('owner', 'hash', ''));
    assert.equal(store.isBootstrapped(), false);
    assert.equal(store.credentials('owner'), undefined);
    assert.ok(store.bootstrap('owner', 'hash', 'Valid').team.id);
  } finally {
    store.close();
    f.cleanup();
  }
});
await test('database rejects invalid role, orphan membership, duplicate channel, singleton and names', () => {
  const f = fixture();
  const store = f.open();
  try {
    const created = store.bootstrap('owner', 'hash', 'Team');
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
          .prepare('INSERT INTO humans VALUES (?, ?, ?)')
          .run('second', 'owner', 'hash'),
      );
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

await test('WAL recovers committed bootstrap and discards an interrupted writer transaction', async () => {
  const { fork } = await import('node:child_process');
  const f = fixture();
  const child = fork(
    new URL('./fixtures/crash-writer.ts', import.meta.url),
    [f.path],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  try {
    await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Writer exited before transaction');
      }),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Writer timeout'));
        }, 10000);
        timer.unref();
      }),
    ]);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const recovered = f.open();
    try {
      const owner = recovered.credentials('owner');
      assert.ok(owner);
      assert.equal(recovered.teamFor(owner.id)?.team.name, 'Committed team');
      assert.equal(recovered.isBootstrapped(), true);
    } finally {
      recovered.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    f.cleanup();
  }
});
