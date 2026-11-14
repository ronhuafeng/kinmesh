import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rawDatabase } from './raw.js';
import { deliver, runWorker } from '../src/inbox/worker.js';
import { INBOX_LIVENESS_MS } from '../src/domain/inbox.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { inboxFixture } from './inbox-helpers.js';
import { postInput } from './communication-helpers.js';

const signal = () => new AbortController().signal;

await test('worker liveness is projected per agent, ignores unknown IDs, goes stale and is withdrawn', async () => {
  const f = await inboxFixture();
  try {
    const snapshot = async () =>
      WorkspaceSnapshot.parse(
        (
          await f.app.inject({ url: '/api/workspace', cookies: f.cookies })
        ).json<unknown>(),
      );
    assert.deepEqual((await snapshot()).wake, []);
    await f.inbox.heartbeat([f.agent.id, randomUUID()]);
    const live = (await snapshot()).wake;
    assert.equal(live.length, 1);
    assert.equal(live[0]?.agentId, f.agent.id);
    assert.equal(live[0].connected, true);
    // Liveness older than the threshold reads as "not connected", never as gone.
    const raw = rawDatabase(f.dbPath);
    try {
      await raw
        .prepare('UPDATE inbox_bindings SET last_seen_at = ?')
        .run(Date.now() - INBOX_LIVENESS_MS - 1000);
    } finally {
      await raw.close();
    }
    assert.equal((await snapshot()).wake[0]?.connected, false);
    await f.inbox.release([f.agent.id]);
    assert.deepEqual((await snapshot()).wake, []);
  } finally {
    await f.dispose();
  }
});

await test('a running worker records liveness for its bindings and withdraws it on a clean stop', async () => {
  const f = await inboxFixture();
  try {
    const stopping = new AbortController();
    let seenWhileRunning: string[] = [];
    const running = runWorker(
      f.store,
      f.workerConfig,
      f.factory,
      stopping.signal,
      async () => {
        seenWhileRunning = (
          await f.store.inboxViews.liveness(f.principal, f.teamId)
        ).map((r) => r.agentId);
        stopping.abort();
        return Promise.resolve();
      },
    );
    await running;
    assert.deepEqual(seenWhileRunning, [f.agent.id]);
    assert.deepEqual(
      await f.store.inboxViews.liveness(f.principal, f.teamId),
      [],
    );
  } finally {
    await f.dispose();
  }
});

await test('workspace projects allow-listed delivery status for visible messages, replies and tasks', async () => {
  const f = await inboxFixture();
  try {
    const snapshot = async () =>
      WorkspaceSnapshot.parse(
        (
          await f.app.inject({
            url: '/api/workspace?channelId=' + f.channelId,
            cookies: f.cookies,
          })
        ).json<unknown>(),
      );
    const source = await f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({
        body: 'Ada, please check this',
        mentions: [{ kind: 'agent', id: f.agent.id }],
      }),
    );
    const queued = (await snapshot()).deliveries;
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.messageId, source.id);
    assert.equal(queued[0].state, 'ready');
    assert.equal(queued[0].reason, 'enqueued');
    assert.ok(queued[0].queuedAt);
    // Worker internals never reach the browser.
    const [sent] = (
      await f.app.inject({
        url: '/api/workspace?channelId=' + f.channelId,
        cookies: f.cookies,
      })
    ).json<{ deliveries: object[] }>().deliveries;
    for (const internal of [
      'claimToken',
      'leaseUntil',
      'nextAttempt',
      'attempts',
      'generation',
      'launch',
      'operationId',
      'reference',
      'eventId',
      'rootId',
      'expiresAt',
      'position',
    ])
      assert.equal(Object.hasOwn(sent ?? {}, internal), false, internal);
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    await deliver(f.store, claim, f.binding, f.factory, signal());
    const replied = (await snapshot()).deliveries.find(
      (d) => d.id === queued[0]?.id,
    );
    assert.equal(replied?.state, 'acked');
    assert.ok(replied.resultMessageId);
    assert.notEqual(replied.updatedAt, null);
    // A task wake is visible on its task.
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    assert.ok(
      (await snapshot()).deliveries.some(
        (d) => d.taskId === task.id && d.agentId === f.agent.id,
      ),
    );
  } finally {
    await f.dispose();
  }
});
