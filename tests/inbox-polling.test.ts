import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { deliver } from '../src/inbox/worker.js';
import { retryDelay, waitDelay } from '../src/domain/inbox.js';
import { CHANGES } from '../src/persistence/database.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { assistantRead, due, inboxFixture } from './inbox-helpers.js';
import { postInput } from './communication-helpers.js';
import { rawDatabase } from './raw.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
const signal = () => new AbortController().signal;

async function mention(f: Fixture) {
  await f.store.messages.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
  );
}
/** One worker attempt at whatever is due, with T3 reachable or not. */
async function attempt(f: Fixture, factory = f.factory) {
  await due(f.dbPath);
  const claim = await f.inbox.claim([f.agent.id]);
  assert.ok(claim);
  await deliver(f.store, claim, f.binding, factory, signal());
  return f.inbox.get(claim.id);
}
const snapshot = async (f: Fixture) =>
  WorkspaceSnapshot.parse(
    (
      await f.app.inject({
        url: '/api/workspace?channelId=' + f.channelId,
        cookies: f.cookies,
      })
    ).json<unknown>(),
  );

/**
 * Proves a healthy run is looked at on its own cadence: within seconds at
 * first, however often T3 failed before it started, and at most every 15
 * seconds once it has run a while, never the minutes failures back off to.
 */
await test('a run under way is looked at again within seconds, whatever failed before it started', async () => {
  assert.equal(waitDelay(0), 2000);
  assert.equal(waitDelay(40_000), 5000);
  assert.equal(waitDelay(3_600_000), 15_000);
  const f = await inboxFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await mention(f);
    // T3 was down for a while: the next try backs off by minutes.
    let failed;
    for (let n = 0; n < 9; n++)
      failed = await attempt(f, () =>
        Promise.reject(new Error('T3 unavailable')),
      );
    assert.ok(failed);
    assert.equal(failed.attempts, 9);
    assert.ok(failed.nextAttempt - Date.now() > retryDelay(9) - 5000);
    // Now T3 runs it: the run is looked at again within seconds.
    f.wire.values.t3_thread_read = assistantRead('Working', 'running');
    const started = await attempt(f);
    assert.equal(started.state, 'waiting');
    assert.ok(started.nextAttempt - Date.now() <= 2000 + 1000);
    // Two minutes on, it is looked at every 15 seconds.
    // Controlled clock fixture only: production code never edits history.
    await raw.exec('DROP TRIGGER inbox_history_immutable ON inbox_history');
    await raw
      .prepare(
        'UPDATE inbox_history SET created_at = created_at - 120000 WHERE delivery_id = ?',
      )
      .run(started.id);
    const later = await attempt(f);
    assert.equal(later.state, 'waiting');
    const next = later.nextAttempt - Date.now();
    assert.ok(next > 15_000 - 1000 && next <= 15_000 + 1000, String(next));
  } finally {
    await raw.close();
    await f.dispose();
  }
});

/**
 * Proves polling is invisible: looking again at a run that is still under
 * way records no history, announces no change (every commit's NOTIFY is in
 * before a marker sent after them) and leaves the workspace's revision and
 * the delivery's times as they were.
 */
await test('looking again at a run still under way records nothing and announces nothing', async () => {
  const f = await inboxFixture();
  const listener = postgres(f.dbPath, { max: 1, onnotice: () => undefined });
  try {
    await mention(f);
    f.wire.values.t3_thread_read = assistantRead('Working', 'running');
    const first = await attempt(f);
    assert.equal(first.state, 'waiting');
    const before = await snapshot(f);
    const history = async () =>
      (
        await listener<{ n: number }[]>`
          select count(*)::int as n from inbox_history
          where delivery_id = ${first.id}`
      )[0]?.n;
    const recorded = await history();

    const heard: string[] = [];
    let marked: () => void = () => undefined;
    const marker = new Promise<void>((done) => {
      marked = done;
    });
    const listening = await listener.listen(CHANGES, (payload) => {
      if (payload === 'marker') marked();
      else heard.push(payload);
    });
    for (let n = 0; n < 3; n++)
      assert.equal((await attempt(f)).state, 'waiting');
    await listener.notify(CHANGES, 'marker');
    await marker;
    await listening.unlisten();

    assert.deepEqual(heard, []);
    assert.equal(await history(), recorded);
    const after = await snapshot(f);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.deliveries, before.deliveries);
    // A change people see is still recorded and shown.
    f.wire.values.t3_thread_read = assistantRead('Done');
    assert.equal((await attempt(f)).state, 'acked');
    assert.notEqual((await snapshot(f)).revision, after.revision);
  } finally {
    await listener.end({ timeout: 5 });
    await f.dispose();
  }
});

/** Proves the agents joined to a channel are read as before, in one query. */
await test('the workspace lists the active agents joined to the channel, in profile order', async () => {
  const f = await inboxFixture();
  try {
    const listed = (await snapshot(f)).agents.map((a) => a.id);
    assert.deepEqual(
      (await snapshot(f)).joinedAgentIds,
      listed.filter((id) => id === f.agent.id || id === f.reviewer.id),
    );
    await f.store.agents.lifecycle(
      f.principal,
      f.teamId,
      f.reviewer.id,
      'disabled',
    );
    assert.deepEqual((await snapshot(f)).joinedAgentIds, [f.agent.id]);
  } finally {
    await f.dispose();
  }
});
