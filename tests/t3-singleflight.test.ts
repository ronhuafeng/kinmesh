import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { ExecutionFailure } from '../src/domain/execution.js';
import { T3Backend } from '../src/adapters/t3/backend.js';
import {
  backendFixture,
  MockWire,
  envelope,
  launch,
  intent,
  options,
  reference,
} from './t3-helpers.js';

const outbound = (wire: MockWire) =>
  wire.calls.filter((c) => c.name === 't3_thread_launch');
function barrier(wires: MockWire[]) {
  const gate = Promise.withResolvers<undefined>();
  for (const wire of wires)
    wire.handler = async (name) => {
      if (name === 't3_thread_launch') await gate.promise;
      return envelope(wire.values[name]);
    };
  return gate;
}
async function lost(f: Awaited<ReturnType<typeof backendFixture>>) {
  f.wire.handler = (name) =>
    name === 't3_thread_launch'
      ? Promise.reject(new Error('Mock lost reply'))
      : Promise.resolve(envelope(f.wire.values[name]));
  const result = await f.backend.launch(launch, intent);
  assert.equal(result.kind, 'uncertain');
  return result.operationId;
}
await test('MOCK F1: two independent SQLite connections reconciling uncertain launch send exactly one outbound retry', async () => {
  const f = await backendFixture();
  const second = f.open();
  const firstWire = new MockWire(),
    secondWire = new MockWire();
  const wires = [firstWire, secondWire];
  const gate = barrier(wires);
  const pending: ReturnType<T3Backend['reconcile']>[] = [];
  try {
    const id = await lost(f);
    const backends = await Promise.all([
      T3Backend.connect(firstWire, f.store.operations, options),
      T3Backend.connect(secondWire, second.operations, options),
    ]);
    for (const backend of backends) pending.push(backend.reconcile(intent, id));
    await Promise.resolve(undefined);
    assert.equal(
      wires.reduce((n, w) => n + outbound(w).length, 0),
      1,
      'Only the durable claim winner may send',
    );
    gate.resolve(undefined);
    const results = await Promise.all(pending);
    assert.equal(results.filter((r) => r.kind === 'known').length, 1);
    assert.equal(
      results.filter((r) => r.kind === 'uncertain' && r.reason === 'in-flight')
        .length,
      1,
    );
    const key = f.wire.calls.find((c) => c.name === 't3_thread_launch')?.args
      .clientRequestId;
    assert.ok(
      wires.every((w) =>
        outbound(w).every((c) => c.args.clientRequestId === key),
      ),
    );
  } finally {
    gate.resolve(undefined);
    await Promise.allSettled(pending);
    second.close();
    f.dispose();
  }
});
await test('MOCK F1: reconciliation cannot resend while initial dispatch holds an active durable claim', async () => {
  const f = await backendFixture();
  const second = f.open();
  const wire = new MockWire();
  const gate = barrier([f.wire, wire]);
  const pending: Promise<unknown>[] = [];
  try {
    const backend = await T3Backend.connect(wire, second.operations, options);
    const first = f.backend.launch(launch, intent);
    pending.push(first);
    const db = new Database(f.path);
    const id = String(
      db.prepare('SELECT id FROM execution_operations').pluck().get(),
    );
    db.close();
    const retry = backend.reconcile(intent, id);
    pending.push(retry);
    await Promise.resolve(undefined);
    assert.equal(
      outbound(f.wire).length + outbound(wire).length,
      1,
      'Initial dispatch excludes concurrent reconcile',
    );
    gate.resolve(undefined);
    assert.equal((await first).kind, 'known');
    assert.deepEqual(await retry, {
      kind: 'uncertain',
      operationId: id,
      reason: 'in-flight',
    });
  } finally {
    gate.resolve(undefined);
    await Promise.allSettled(pending);
    second.close();
    f.dispose();
  }
});
await test('MOCK F1: crashed dispatch lease survives reopen, blocks until expiry and recovers with exact persisted key', async () => {
  const f = await backendFixture();
  let reopened: ReturnType<typeof f.open> | undefined;
  try {
    const scope = createHash('sha256')
      .update(JSON.stringify([options.endpoint, reference.environmentId]))
      .digest('hex');
    const row = f.store.operations.prepare(
      scope,
      intent,
      't3_thread_launch',
      {
        scratch: true,
        title: launch.title,
        modelSelection: {
          provider: 'codex',
          instanceId: launch.model.providerId,
          model: launch.model.modelId,
        },
        runtimeMode: launch.mode,
        interactionMode: 'default',
      },
      options.authority,
    );
    assert.ok(f.store.operations.claim(row.id));
    f.store.close();
    reopened = f.open();
    const wire = new MockWire();
    const backend = await T3Backend.connect(wire, reopened.operations, options);
    assert.deepEqual(await backend.reconcile(intent, row.id), {
      kind: 'uncertain',
      operationId: row.id,
      reason: 'in-flight',
    });
    assert.equal(outbound(wire).length, 0);
    const db = new Database(f.path);
    db.prepare('UPDATE execution_operations SET lease_until=? WHERE id=?').run(
      Date.now() - 1,
      row.id,
    );
    db.close();
    assert.equal((await backend.reconcile(intent, row.id)).kind, 'known');
    assert.equal(outbound(wire).length, 1);
    assert.equal(outbound(wire)[0]?.args.clientRequestId, row.requestId);
  } finally {
    reopened?.close();
    f.dispose();
  }
});

function expire(path: string, id: string) {
  const db = new Database(path);
  try {
    db.prepare('UPDATE execution_operations SET lease_until=? WHERE id=?').run(
      Date.now() - 1,
      id,
    );
  } finally {
    db.close();
  }
}
function prepared(f: Awaited<ReturnType<typeof backendFixture>>) {
  return f.store.operations.prepare(
    'fence-test',
    intent,
    't3_thread_launch',
    {},
    options.authority,
  );
}
await test('MOCK F1: every journal write fences expired and superseded owners; terminal outcomes cannot downgrade', async () => {
  for (const terminal of ['known', 'rejected'] as const) {
    const f = await backendFixture();
    const second = f.open();
    try {
      const row = prepared(f);
      const first = f.store.operations.claim(row.id);
      assert.ok(first);
      assert.equal(first.leaseUntil > Date.now() + 60_000, true);
      expire(f.path, row.id);
      const staleWrites = () => {
        assert.equal(f.store.operations.owned(first), false);
        assert.equal(f.store.operations.remember(first, reference), false);
        assert.equal(f.store.operations.known(first, reference), false);
        assert.equal(f.store.operations.rejected(first, 'permission'), false);
        assert.equal(f.store.operations.uncertain(first), false);
      };
      staleWrites();
      assert.equal(
        second.operations.claim(row.id),
        undefined,
        'Normal dispatch cannot recover an expired attempt',
      );
      const next = second.operations.claim(row.id, true);
      assert.ok(next);
      assert.equal(next.generation, first.generation + 1);
      assert.notEqual(next.claimToken, first.claimToken);
      assert.equal(next.requestId, first.requestId);
      staleWrites();
      assert.equal(f.store.operations.claim(row.id, true), undefined);
      if (terminal === 'known')
        assert.equal(second.operations.known(next, reference), true);
      else assert.equal(second.operations.rejected(next, 'permission'), true);
      staleWrites();
      assert.equal(second.operations.uncertain(next), false);
      assert.equal(f.store.operations.claim(row.id, true), undefined);
      assert.equal(second.operations.get(row.id).phase, terminal);
    } finally {
      second.close();
      f.dispose();
    }
  }
});
await test('MOCK F1: normal dispatch cannot claim a stale prepared snapshot after uncertainty', async () => {
  const f = await backendFixture();
  try {
    const row = prepared(f);
    const claim = f.store.operations.claim(row.id);
    assert.ok(claim);
    assert.equal(f.store.operations.uncertain(claim), true);
    assert.equal(f.store.operations.claim(row.id), undefined);
    assert.ok(f.store.operations.claim(row.id, true));
  } finally {
    f.dispose();
  }
});
for (const outcome of ['known', 'rejected'] as const) {
  await test(`MOCK F1: expired dispatch's late success cannot overwrite a newer ${outcome} outcome`, async () => {
    const f = await backendFixture();
    const second = f.open();
    const wire = new MockWire();
    const gate = barrier([f.wire]);
    let pending: Promise<unknown> | undefined;
    try {
      const backend = await T3Backend.connect(wire, second.operations, options);
      pending = f.backend.launch(launch, intent);
      const db = new Database(f.path);
      const id = String(
        db.prepare('SELECT id FROM execution_operations').pluck().get(),
      );
      db.close();
      expire(f.path, id);
      if (outcome === 'rejected')
        wire.handler = (name) =>
          name === 't3_thread_launch'
            ? Promise.resolve({
                isError: true,
                structuredContent: { code: 'capability_denied' },
                content: [],
              })
            : Promise.resolve(envelope(wire.values[name]));
      if (outcome === 'known')
        assert.equal((await backend.reconcile(intent, id)).kind, 'known');
      else
        await assert.rejects(
          backend.reconcile(intent, id),
          (e) => e instanceof ExecutionFailure && e.kind === 'permission',
        );
      const saved = second.operations.get(id);
      gate.resolve(undefined);
      assert.deepEqual(await pending, {
        kind: 'uncertain',
        operationId: id,
        reason: 'in-flight',
      });
      assert.deepEqual(second.operations.get(id), saved);
      assert.equal(
        outbound(f.wire)[0]?.args.clientRequestId,
        outbound(wire)[0]?.args.clientRequestId,
      );
      assert.ok(
        outbound(f.wire)[0]?.signal,
        'Mutation has an attempt deadline',
      );
      assert.equal(
        f.wire.calls.filter((c) => c.name === 't3_thread_read').length,
        0,
        'Stale response must not proceed to journal/read',
      );
      if (outcome === 'known')
        assert.equal((await backend.reconcile(intent, id)).kind, 'known');
      else
        await assert.rejects(
          backend.reconcile(intent, id),
          (e) => e instanceof ExecutionFailure && e.kind === 'permission',
        );
      assert.equal(
        outbound(wire).length,
        1,
        'Terminal reconciliation never sends another mutation',
      );
    } finally {
      gate.resolve(undefined);
      await pending;
      second.close();
      f.dispose();
    }
  });
}
await test('MOCK F1: provisional reference takeover is read-only and late failed read cannot downgrade known', async () => {
  const f = await backendFixture();
  const second = f.open();
  const wire = new MockWire();
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let pending: Promise<unknown> | undefined;
  try {
    f.wire.handler = async (name) => {
      if (name === 't3_thread_read') {
        entered.resolve(undefined);
        await release.promise;
        throw new ExecutionFailure('authentication');
      }
      return envelope(f.wire.values[name]);
    };
    const backend = await T3Backend.connect(wire, second.operations, options);
    pending = f.backend.launch(launch, intent);
    await entered.promise;
    const db = new Database(f.path);
    const id = String(
      db.prepare('SELECT id FROM execution_operations').pluck().get(),
    );
    db.close();
    assert.notEqual(second.operations.get(id).reference, null);
    expire(f.path, id);
    assert.equal((await backend.reconcile(intent, id)).kind, 'known');
    assert.equal(outbound(wire).length, 0);
    const saved = second.operations.get(id);
    release.resolve(undefined);
    assert.deepEqual(await pending, {
      kind: 'uncertain',
      operationId: id,
      reason: 'in-flight',
    });
    assert.deepEqual(second.operations.get(id), saved);
  } finally {
    release.resolve(undefined);
    await pending;
    second.close();
    f.dispose();
  }
});

await test(
  'MOCK F1: independent claimant processes have one winner; SIGKILL/reopen recovers unchanged native key',
  { timeout: 15_000 },
  async () => {
    const f = await backendFixture();
    const children: ReturnType<typeof fork>[] = [];
    try {
      const id = await lost(f);
      const original = f.store.operations.get(id);
      for (let n = 0; n < 2; n++) {
        const child = fork(
          new URL('./fixtures/operation-claimant.ts', import.meta.url),
          [f.path, id],
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
        );
        children.push(child);
        assert.equal(
          (
            await once(child, 'message', {
              signal: AbortSignal.timeout(10_000),
            })
          )[0],
          'ready',
        );
      }
      const results = children.map((child) =>
        once(child, 'message', { signal: AbortSignal.timeout(10_000) }),
      );
      for (const child of children) child.send('claim');
      const claims = await Promise.all(results);
      assert.equal(claims.filter((r) => r[0] === 'claimed').length, 1);
      assert.equal(claims.filter((r) => r[0] === 'busy').length, 1);
      assert.deepEqual(await f.backend.reconcile(intent, id), {
        kind: 'uncertain',
        operationId: id,
        reason: 'in-flight',
      });
      for (const child of children) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      f.store.close();
      const reopened = f.open();
      try {
        const wire = new MockWire();
        const backend = await T3Backend.connect(
          wire,
          reopened.operations,
          options,
        );
        assert.deepEqual(await backend.reconcile(intent, id), {
          kind: 'uncertain',
          operationId: id,
          reason: 'in-flight',
        });
        expire(f.path, id);
        assert.equal((await backend.reconcile(intent, id)).kind, 'known');
        assert.equal(outbound(wire).length, 1);
        assert.equal(
          outbound(wire)[0]?.args.clientRequestId,
          original.requestId,
        );
        assert.equal(reopened.operations.get(id).generation, 3);
      } finally {
        reopened.close();
      }
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      f.dispose();
    }
  },
);
