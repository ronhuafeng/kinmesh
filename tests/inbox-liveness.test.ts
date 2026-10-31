import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runWorker } from '../src/inbox/worker.js';
import { INBOX_LIVENESS_MS } from '../src/domain/inbox.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { inboxFixture } from './inbox-helpers.js';

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
    f.inbox.heartbeat([f.agent.id, randomUUID()]);
    const live = (await snapshot()).wake;
    assert.equal(live.length, 1);
    assert.equal(live[0]?.agentId, f.agent.id);
    assert.equal(live[0].connected, true);
    // Liveness older than the threshold reads as "not connected", never as gone.
    const raw = new Database(f.dbPath);
    try {
      raw
        .prepare('UPDATE inbox_bindings SET last_seen_at = ?')
        .run(Date.now() - INBOX_LIVENESS_MS - 1000);
    } finally {
      raw.close();
    }
    assert.equal((await snapshot()).wake[0]?.connected, false);
    f.inbox.release([f.agent.id]);
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
      () => {
        seenWhileRunning = f.inbox.liveness(f.teamId).map((r) => r.agentId);
        stopping.abort();
        return Promise.resolve();
      },
    );
    await running;
    assert.deepEqual(seenWhileRunning, [f.agent.id]);
    assert.deepEqual(f.inbox.liveness(f.teamId), []);
  } finally {
    await f.dispose();
  }
});
