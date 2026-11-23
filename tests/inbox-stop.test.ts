import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { deliver } from '../src/inbox/worker.js';
import { MessageId } from '../src/domain/communication.js';
import { due, inboxFixture } from './inbox-helpers.js';
import { key, postInput } from './communication-helpers.js';
import { envelope, launched, mockRead, reference } from './t3-helpers.js';
import { rawDatabase } from './raw.js';
import { mockNativeServer } from './native-helpers.js';
import { saveCredential } from '../src/adapters/t3/oauth.js';
import {
  managedDirectory,
  privateDirectory,
  t3AuthFile,
} from '../src/runtime/managed.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
const signal = () => new AbortController().signal;
const Args = z.record(z.string(), z.unknown());

async function mention(f: Fixture) {
  await f.comm.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
  );
}
/** One worker attempt at whatever is due for the agent. */
async function attempt(f: Fixture) {
  await due(f.dbPath);
  const claim = await f.inbox.claim([f.agent.id]);
  assert.ok(claim);
  await deliver(f.store, claim, f.binding, f.factory, signal());
  return f.inbox.get(claim.id);
}
/** A person presses Stop on the delivery (or an agent tries to). */
const stop = (
  f: Fixture,
  id: string,
  operationKey = key(),
  headers: Record<string, string> = {},
) =>
  f.app.inject({
    method: 'POST',
    url: `/api/teams/${f.teamId}/deliveries/${id}/stop`,
    ...(Object.keys(headers).length ? { headers } : { cookies: f.cookies }),
    payload: { operationKey },
  });
const calls = (f: Fixture, name: string) =>
  f.wire.calls.filter((c) => c.name === name).map((c) => Args.parse(c.args));
/** T3's view of the run: its status and no reply written. */
const run = (status: string) => ({ ...mockRead(status), items: [] });

/**
 * Proves a person ends a run waiting for an approval in T3: the run is
 * interrupted once under a journaled operation, the delivery ends with the
 * stopped notice posted once, and stopping it again changes nothing.
 */
await test('a person stops a run waiting in T3: it is interrupted once and its stopped notice is posted once', async () => {
  const f = await inboxFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await mention(f);
    f.wire.values.t3_thread_read = run('waiting');
    const waiting = await attempt(f);
    assert.equal(waiting.state, 'waiting', waiting.reason);
    assert.equal(waiting.reason, 'human-or-approval-wait');

    const operation = key();
    assert.equal((await stop(f, waiting.id, operation)).statusCode, 200);
    // A lost response is retried with the same key and replays.
    assert.equal((await stop(f, waiting.id, operation)).statusCode, 200);
    const asked = await f.inbox.get(waiting.id);
    assert.equal(asked.state, 'waiting');
    assert.equal(asked.reason, 'stop-requested');
    assert.notEqual(asked.stopRequestedAt, null);
    assert.equal(calls(f, 't3_thread_interrupt').length, 0);

    // The worker interrupts the run; T3 has not finished it yet.
    const stopping = await attempt(f);
    assert.equal(stopping.state, 'waiting', stopping.reason);
    const [interrupt] = calls(f, 't3_thread_interrupt');
    assert.ok(interrupt);
    assert.equal(interrupt.threadId, launched.threadId);
    assert.equal(interrupt.runId, launched.runId);
    // The thread's queue goes on: later messages aren't held back.
    assert.equal(interrupt.stop, undefined);

    // T3 reports it interrupted: the stopped notice is the answer.
    f.wire.values.t3_thread_read = run('interrupted');
    const ended = await attempt(f);
    assert.equal(ended.state, 'acked', ended.reason);
    assert.equal(ended.reason, 'native-terminal-notice-published');
    assert.equal(calls(f, 't3_thread_interrupt').length, 1);
    const notice = await f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      MessageId.parse(ended.resultMessageId),
    );
    assert.equal(notice.body, '还没回复就停止了。');

    // Ending one that already finished is a no-op.
    assert.equal((await stop(f, waiting.id)).statusCode, 200);
    const after = await f.inbox.get(waiting.id);
    assert.equal(after.state, 'acked');
    assert.equal(after.resultMessageId, ended.resultMessageId);
    assert.equal(
      await raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
      1,
    );
  } finally {
    await raw.close();
    await f.dispose();
  }
});

/**
 * Proves only the delivery's own run waits for an approval: T3 keeps the
 * request a run interrupted while waiting left behind and counts it for the
 * thread, so a later run that is working must not read as waiting for one.
 */
await test('an approval an interrupted run left in T3 does not make a later run wait for one', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    const [template] = mockRead().items;
    assert.ok(template);
    /** T3's thread with its activity: the requests still waiting, by run. */
    const thread = (waiting: string[]) => {
      const read = run('running');
      Object.assign(read.thread, {
        pendingRequestCount: waiting.length,
        itemCount: 120,
      });
      return {
        read,
        activity: {
          ...read,
          items: waiting.map((runId, i) => ({
            ...template,
            itemId: 'request-' + String(i),
            position: 110 + i,
            runId,
            type: 'approval_request',
            status: 'waiting',
          })),
        },
      };
    };
    let t3 = thread(['interrupted-earlier-run']);
    f.wire.handler = (name, args) =>
      Promise.resolve(
        envelope(
          name !== 't3_thread_read'
            ? f.wire.values[name]
            : args.view === 'activity'
              ? t3.activity
              : t3.read,
        ),
      );
    const working = await attempt(f);
    assert.equal(working.state, 'waiting', working.reason);
    assert.equal(working.reason, 'execution-active');
    // Only the thread's latest activity is read, without its text.
    const [activity] = calls(f, 't3_thread_read').filter(
      (c) => c.view === 'activity',
    );
    assert.ok(activity);
    assert.equal(activity.afterPosition, 19);
    assert.equal(activity.maxCharsPerItem, 1);

    // The run asks for an approval of its own.
    t3 = thread(['interrupted-earlier-run', launched.runId ?? '']);
    const asking = await attempt(f);
    assert.equal(asking.state, 'waiting', asking.reason);
    assert.equal(asking.reason, 'human-or-approval-wait');
  } finally {
    await f.dispose();
  }
});

await test('a delivery nothing of which reached T3 ends at once, and T3 is never called', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    const [queued] = await f.rows();
    assert.ok(queued);
    assert.equal(queued.state, 'ready');
    assert.equal((await stop(f, queued.id)).statusCode, 200);
    const ended = await f.inbox.get(queued.id);
    assert.equal(ended.state, 'expired');
    assert.equal(ended.reason, 'stopped');
    // The worker finds nothing to do for it.
    await due(f.dbPath);
    assert.equal(await f.inbox.claim([f.agent.id]), undefined);
    assert.equal(f.wire.calls.length, 0);
  } finally {
    await f.dispose();
  }
});

await test('stopped while a worker is about to send it: nothing is sent', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    await due(f.dbPath);
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    // The worker holds it, so only the request is recorded.
    assert.equal((await stop(f, claim.id)).statusCode, 200);
    assert.equal((await f.inbox.get(claim.id)).state, 'ready');
    await deliver(f.store, claim, f.binding, f.factory, signal());
    const ended = await f.inbox.get(claim.id);
    assert.equal(ended.state, 'expired', ended.reason);
    assert.equal(ended.reason, 'stopped');
    assert.equal(calls(f, 't3_thread_launch').length, 0);
    assert.equal(calls(f, 't3_thread_send').length, 0);
  } finally {
    await f.dispose();
  }
});

await test('stopping follows the resume rule: people who can read the channel, never agents', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = run('running');
    const working = await attempt(f);
    assert.equal(working.state, 'waiting', working.reason);
    // Agents never stop deliveries, even with every scope.
    const agent = await stop(f, working.id, key(), {
      authorization: 'Bearer ' + f.inboxGrant.token,
    });
    assert.equal(agent.statusCode, 403);
    assert.equal((await stop(f, randomUUID())).statusCode, 404);
    // A blocked run in T3 can't be reached from Kinmesh: retry it first.
    await due(f.dbPath);
    const held = await f.inbox.claim([f.agent.id]);
    assert.ok(held);
    await f.inbox.defer(held, 'blocked', 'native-unreadable');
    assert.equal((await stop(f, working.id)).statusCode, 409);
    assert.equal((await f.inbox.get(working.id)).stopRequestedAt, null);
    // Someone who left the channel can't reach its deliveries.
    await f.comm.membership(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    assert.notEqual((await stop(f, working.id)).statusCode, 200);
  } finally {
    await f.dispose();
  }
});

/**
 * Proves a delivery blocked because the T3 access its run started under is
 * gone can be ended: T3 is never asked, it ends keeping why, a retry
 * replays, and nothing is ever posted for it.
 */
await test('a delivery whose run’s T3 access is gone ends at once without asking T3', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = run('running');
    const working = await attempt(f);
    assert.equal(working.state, 'waiting', working.reason);
    await due(f.dbPath);
    const held = await f.inbox.claim([f.agent.id]);
    assert.ok(held);
    await f.inbox.defer(held, 'blocked', 'authority-changed');
    const before = f.wire.calls.length;

    const operation = key();
    assert.equal((await stop(f, working.id, operation)).statusCode, 200);
    // A lost response is retried with the same key and replays.
    assert.equal((await stop(f, working.id, operation)).statusCode, 200);
    const ended = await f.inbox.get(working.id);
    assert.equal(ended.state, 'expired');
    assert.equal(ended.reason, 'authority-changed');
    assert.notEqual(ended.stopRequestedAt, null);
    assert.equal(ended.resultMessageId, null);
    assert.equal(f.wire.calls.length, before);

    // Nothing is left for a worker, and stopping it again changes nothing.
    await due(f.dbPath);
    assert.equal(await f.inbox.claim([f.agent.id]), undefined);
    assert.equal((await stop(f, working.id)).statusCode, 200);
    assert.deepEqual(await f.inbox.get(working.id), ended);
  } finally {
    await f.dispose();
  }
});

/**
 * Proves a run waiting for an approval links to its thread on the team's T3
 * origin, where T3's web UI shows it, for a person who can read the channel,
 * whatever link T3's read gives (T3 0.1.9's points at its hosted app); never
 * for an agent.
 */
await test('a run waiting for an approval links to its thread in T3', async () => {
  const f = await inboxFixture();
  const mock = await mockNativeServer();
  try {
    await mention(f);
    const [queued] = await f.rows();
    assert.ok(queued);
    const url = `/api/teams/${f.teamId}/deliveries/${queued.id}/link`;
    const link = () => f.app.inject({ url, cookies: f.cookies });
    // Before its run is in T3 there is nothing to link to.
    assert.deepEqual((await link()).json(), { url: null });

    f.wire.values.t3_thread_read = run('waiting');
    const waiting = await attempt(f);
    assert.equal(waiting.reason, 'human-or-approval-wait');
    await f.store.managed.saveConnection(
      f.principal,
      f.teamId,
      mock.endpoint,
      'env-one',
    );
    const directory = managedDirectory(f.directory);
    privateDirectory(directory);
    saveCredential(t3AuthFile(directory), mock.credential);
    const linked = await link();
    assert.equal(linked.statusCode, 200, linked.body);
    assert.equal(linked.headers['cache-control'], 'no-store');
    assert.deepEqual(linked.json(), {
      url: `${mock.origin}/${reference.environmentId}/${encodeURIComponent(reference.threadId)}`,
    });
    assert.ok(
      mock.calls.every((call) =>
        ['t3_environment_read', 't3_thread_read'].includes(call.name),
      ),
    );

    // T3 that can't be read is one generic answer.
    mock.mode.value = 'bad-read';
    assert.equal((await link()).statusCode, 503);

    // Agents never ask.
    const agent = await f.app.inject({
      url,
      headers: { authorization: 'Bearer ' + f.inboxGrant.token },
    });
    assert.equal(agent.statusCode, 403);
  } finally {
    await mock.close();
    await f.dispose();
  }
});
