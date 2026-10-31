import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { Claim } from '../src/domain/inbox.js';
import { Correlation } from '../src/domain/agents.js';
import { reference } from './t3-helpers.js';
import { inboxFixture, due, fixtureResult } from './inbox-helpers.js';
import { postInput } from './communication-helpers.js';
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close', { signal: AbortSignal.timeout(10000) });
  child.kill(signal);
  await exited;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture deadline');
    await delay(25);
  }
}
function worker(path: string, mode = 'normal') {
  return fork(
    new URL('./fixtures/inbox-worker.ts', import.meta.url),
    [path, mode],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
}
await test(
  'MOCK: two independent worker processes race one inbox; SIGKILL leases recover with same native key and stale fence',
  { timeout: 30000 },
  async () => {
    const f = await inboxFixture();
    const children: ChildProcess[] = [];
    const raw = new Database(f.dbPath);
    raw.pragma('busy_timeout=5000');
    try {
      f.comm.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
      );
      for (let i = 0; i < 2; i++) {
        const c = worker(f.configPath, 'hold');
        children.push(c);
        assert.equal(
          (await once(c, 'message', { signal: AbortSignal.timeout(10000) }))[0],
          'ready',
        );
      }
      await until(
        () =>
          raw
            .prepare('SELECT count(*) FROM execution_operations')
            .pluck()
            .get() === 1,
      );
      await until(
        () =>
          raw
            .prepare('SELECT count(*) FROM fixture_native_launches')
            .pluck()
            .get() === 1,
      );
      const original = f.rows()[0];
      assert.ok(original);
      const stale = Claim.parse(original);
      const native = z
        .object({ request_id: z.string(), transmissions: z.number() })
        .parse(raw.prepare('SELECT * FROM fixture_native_launches').get());
      assert.equal(native.transmissions, 1);
      assert.equal(
        f.inbox.claim([f.agent.id]),
        undefined,
        'neither process nor third connection can steal active lease',
      );
      assert.equal(
        raw.prepare('SELECT generation FROM agent_inbox').pluck().get(),
        1,
      );
      for (const c of children) await stop(c, 'SIGKILL');
      const reopened = f.open();
      try {
        assert.equal(
          reopened.inbox.claim([f.agent.id]),
          undefined,
          'kill does not release durable lease',
        );
      } finally {
        reopened.close();
      }
      due(f.dbPath, true);
      raw.exec(
        "UPDATE execution_operations SET lease_until=1 WHERE phase='dispatching'",
      );
      const recovery = worker(f.configPath);
      children.push(recovery);
      await once(recovery, 'message', { signal: AbortSignal.timeout(10000) });
      await until(() => f.inbox.get(stale.id).state === 'acked');
      await stop(recovery);
      assert.equal(
        raw
          .prepare('SELECT count(*) FROM fixture_native_launches')
          .pluck()
          .get(),
        1,
        'one native idempotency key across process crash',
      );
      assert.equal(
        raw
          .prepare('SELECT transmissions FROM fixture_native_launches')
          .pluck()
          .get(),
        2,
        'only explicit reconciliation retransmits',
      );
      assert.equal(
        raw
          .prepare('SELECT request_id FROM execution_operations')
          .pluck()
          .get(),
        native.request_id,
      );
      assert.equal(f.inbox.get(stale.id).generation, 3);
      assert.equal(
        raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
        1,
      );
      assert.throws(() => {
        f.inbox.defer(stale, 'uncertain', 'stale');
      });
      assert.throws(() => {
        f.inbox.remember(stale, { operationId: randomOperation() });
      });
    } finally {
      for (const c of children) await stop(c, 'SIGKILL');
      raw.close();
      await f.dispose();
    }
  },
);
await test(
  'MOCK SQLite: SIGKILL after an agent prelinks its Run recovers one publication without relaunch',
  { timeout: 30000 },
  async () => {
    const f = await inboxFixture();
    const children: ChildProcess[] = [];
    const raw = new Database(f.dbPath);
    raw.pragma('busy_timeout=5000');
    try {
      const task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
      const originalWorker = worker(f.configPath, 'prelinked-hold');
      children.push(originalWorker);
      await until(
        () =>
          raw.prepare('SELECT count(*) FROM task_executions').pluck().get() ===
          1,
      );
      const original = f.rows()[0];
      assert.ok(original);
      assert.ok(original.reference);
      const stale = Claim.parse(original);
      const requestId: unknown = raw
        .prepare('SELECT request_id FROM execution_operations')
        .pluck()
        .get();
      assert.equal(typeof requestId, 'string');
      await stop(originalWorker, 'SIGKILL');
      assert.equal(
        f.inbox.claim([f.agent.id]),
        undefined,
        'Crash cannot release the live lease',
      );
      due(f.dbPath, true);
      const recovery = worker(f.configPath);
      children.push(recovery);
      await until(() => f.inbox.get(original.id).state === 'acked');
      await stop(recovery);
      const result = f.inbox.get(original.id);
      assert.equal(result.generation, original.generation + 1);
      assert.equal(result.reference, original.reference);
      assert.equal(result.launch, original.launch);
      assert.equal(
        raw.prepare('SELECT count(*) FROM task_executions').pluck().get(),
        1,
      );
      assert.equal(
        raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
        1,
      );
      assert.equal(
        raw.prepare('SELECT count(*) FROM agent_correlations').pluck().get(),
        1,
      );
      assert.equal(
        raw.prepare('SELECT task_link_id FROM inbox_results').pluck().get(),
        raw.prepare('SELECT id FROM task_executions').pluck().get(),
      );
      assert.equal(
        raw
          .prepare('SELECT request_id FROM execution_operations')
          .pluck()
          .get(),
        requestId,
      );
      assert.equal(
        raw
          .prepare('SELECT count(*) FROM fixture_native_launches')
          .pluck()
          .get(),
        1,
      );
      assert.equal(
        raw
          .prepare('SELECT transmissions FROM fixture_native_launches')
          .pluck()
          .get(),
        1,
        'A remembered Run is read, never relaunched',
      );
      assert.ok(result.resultMessageId);
      assert.equal(
        f.comm.message(
          f.principal,
          f.teamId,
          f.channelId,
          result.resultMessageId,
        ).sourceEventId,
        original.eventId,
      );
      assert.equal(
        f.tasks.get(f.principal, f.teamId, f.channelId, task.id).state.status,
        'in-progress',
      );
      assert.throws(() =>
        f.inbox.ack(stale, f.workerPrincipal, fixtureResult()),
      );
    } finally {
      for (const child of children) await stop(child, 'SIGKILL');
      raw.close();
      await f.dispose();
    }
  },
);
function randomOperation() {
  return 'stale-operation';
}
await test(
  'MOCK SQLite: SIGKILL after the execution API correlates a Run recovers one ACK without relaunch',
  { timeout: 30000 },
  async () => {
    const f = await inboxFixture();
    const children: ChildProcess[] = [];
    const raw = new Database(f.dbPath);
    raw.pragma('busy_timeout=5000');
    try {
      f.create({ owner: { kind: 'agent', id: f.agent.id } });
      const originalWorker = worker(f.configPath, 'publication-hold');
      children.push(originalWorker);
      await until(() => f.rows()[0]?.reference !== null);
      const original = f.rows()[0];
      assert.ok(original?.reference);
      const stale = Claim.parse(original);
      const response = await f.app.inject({
        method: 'POST',
        url: `/api/teams/${f.teamId}/agents/${f.agent.id}/executions`,
        cookies: f.cookies,
        payload: {
          reference,
          providerSessionId: 'mock-pre-crash-session',
          invocationId: 'mock-pre-crash-invocation',
        },
      });
      assert.equal(response.statusCode, 201);
      const existing = Correlation.parse(response.json<unknown>());
      const journalBefore: unknown = raw
        .prepare('SELECT * FROM execution_operations')
        .get();
      await stop(originalWorker, 'SIGKILL');
      assert.equal(f.inbox.claim([f.agent.id]), undefined);
      due(f.dbPath, true);
      const recovery = worker(f.configPath);
      children.push(recovery);
      await until(() => {
        const row = f.inbox.get(original.id);
        return row.generation > original.generation && row.claimToken === null;
      });
      await stop(recovery);
      const result = f.inbox.get(original.id);
      assert.equal(
        result.state,
        'acked',
        'A preexisting correlation must not strand crash recovery',
      );
      assert.equal(result.generation, original.generation + 1);
      assert.equal(result.launch, original.launch);
      assert.equal(result.reference, original.reference);
      assert.deepEqual(
        f.store.agents.correlations(f.principal, f.teamId, f.agent.id),
        [existing],
      );
      assert.deepEqual(
        raw.prepare('SELECT * FROM execution_operations').get(),
        journalBefore,
      );
      assert.equal(
        raw.prepare('SELECT correlation_id FROM inbox_results').pluck().get(),
        existing.id,
      );
      for (const table of [
        'agent_runtime_events',
        'inbox_results',
        'task_executions',
        'fixture_native_launches',
      ])
        assert.equal(
          raw
            .prepare('SELECT count(*) FROM ' + table)
            .pluck()
            .get(),
          1,
        );
      assert.equal(
        raw
          .prepare('SELECT transmissions FROM fixture_native_launches')
          .pluck()
          .get(),
        1,
      );
      assert.throws(() =>
        f.inbox.ack(stale, f.workerPrincipal, fixtureResult()),
      );
    } finally {
      for (const child of children) await stop(child, 'SIGKILL');
      raw.close();
      await f.dispose();
    }
  },
);
await test(
  'ordinary independently supervised CLI starts, stops gracefully and restarts without live T3',
  { timeout: 30000 },
  async () => {
    const f = await inboxFixture();
    const children: ChildProcess[] = [];
    try {
      const path = join(f.directory, 'idle-worker.json');
      writeFileSync(path, JSON.stringify({ ...f.workerConfig, bindings: [] }), {
        mode: 0o600,
      });
      f.comm.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        // Signal the worker itself: npm/shell process-group forwarding differs on macOS.
        const child = spawn(
          process.execPath,
          ['--env-file-if-exists=.env', '--import', 'tsx', 'src/inbox/main.ts'],
          {
            env: { ...process.env, KINMESH_INBOX_CONFIG: path },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          },
        );
        children.push(child);
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        await until(() => output.includes('Kinmesh Inbox worker ready.'));
        const exited = once(child, 'close', {
          signal: AbortSignal.timeout(10000),
        });
        assert.ok(child.pid);
        child.kill('SIGTERM');
        await exited;
        assert.ok(output.includes('Kinmesh Inbox worker stopped.'));
        assert.equal(f.rows()[0]?.state, 'ready');
        assert.equal(f.rows()[0]?.generation, 0);
      }
      const bad = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/inbox/main.ts'],
        {
          env: {
            ...process.env,
            KINMESH_INBOX_CONFIG: join(f.directory, 'absent.json'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(bad);
      let error = '';
      bad.stderr.on('data', (c: Buffer) => {
        error += c.toString();
      });
      const exited = await once(bad, 'exit', {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(exited[0], 1);
      assert.ok(error.includes('Inbox worker failed.'));
    } finally {
      for (const c of children) await stop(c, 'SIGKILL');
      await f.dispose();
    }
  },
);
await test(
  'INBOX LIVE GATE NEGATIVE: missing native approval/configuration exits one without skip or provider output',
  { timeout: 10000 },
  async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/inbox-t3-live.ts'],
      {
        env: {
          ...process.env,
          KINMESH_INBOX_LIVE: '0',
          KINMESH_INBOX_CONFIG: '',
          KINMESH_TEAM_LIVE_DIR: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString();
    });
    const exited = await once(child, 'close', {
      signal: AbortSignal.timeout(9000),
    });
    assert.equal(exited[0], 1);
    assert.ok(out.includes('INBOX_T3_NATIVE FAIL at configuration'));
    assert.equal(out.includes('PASS'), false);
  },
);
