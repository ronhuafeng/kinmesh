import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
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
import { forkWorker, message, stop } from './process-helpers.js';

const outbound = (wire: MockWire) =>
  wire.calls.filter((c) => c.name === 't3_thread_launch');
/**
 * Holds every launch at T3 until released; `reached` settles when the first
 * one gets there, so a test waits for that, not for a number of ticks.
 */
function barrier(wires: MockWire[]) {
  const gate = Promise.withResolvers<undefined>();
  const reached = Promise.withResolvers<undefined>();
  for (const wire of wires)
    wire.handler = async (name) => {
      if (name === 't3_thread_launch') {
        reached.resolve(undefined);
        await gate.promise;
      }
      return envelope(wire.values[name]);
    };
  return { ...gate, reached: reached.promise };
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
    // One reaches T3 and is held there; the other, having lost the claim,
    // settles without sending.
    await gate.reached;
    await Promise.race(pending);
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
    await second.close();
    await f.dispose();
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
    // The first dispatch is held at T3, its claim active.
    await gate.reached;
    const db = new Database(f.path);
    const id = String(
      db.prepare('SELECT id FROM execution_operations').pluck().get(),
    );
    db.close();
    const retry = backend.reconcile(intent, id);
    pending.push(retry);
    // Excluded by the active claim, the reconcile settles without sending.
    await retry;
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
    await second.close();
    await f.dispose();
  }
});
await test('MOCK F1: crashed dispatch lease survives reopen, blocks until expiry and recovers with exact persisted key', async () => {
  const f = await backendFixture();
  let reopened: ReturnType<typeof f.open> | undefined;
  try {
    const scope = createHash('sha256')
      .update(JSON.stringify([options.endpoint, reference.environmentId]))
      .digest('hex');
    const row = await f.store.operations.prepare(
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
    assert.ok(await f.store.operations.claim(row.id));
    await f.store.close();
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
    await reopened?.close();
    await f.dispose();
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
      const row = await prepared(f);
      const first = await f.store.operations.claim(row.id);
      assert.ok(first);
      assert.equal(first.leaseUntil > Date.now() + 60_000, true);
      expire(f.path, row.id);
      const staleWrites = async () => {
        assert.equal(await f.store.operations.owned(first), false);
        assert.equal(
          await f.store.operations.remember(first, reference),
          false,
        );
        assert.equal(await f.store.operations.known(first, reference), false);
        assert.equal(
          await f.store.operations.rejected(first, 'permission'),
          false,
        );
        assert.equal(await f.store.operations.uncertain(first), false);
      };
      await staleWrites();
      assert.equal(
        await second.operations.claim(row.id),
        undefined,
        'Normal dispatch cannot recover an expired attempt',
      );
      const next = await second.operations.claim(row.id, true);
      assert.ok(next);
      assert.equal(next.generation, first.generation + 1);
      assert.notEqual(next.claimToken, first.claimToken);
      assert.equal(next.requestId, first.requestId);
      await staleWrites();
      assert.equal(await f.store.operations.claim(row.id, true), undefined);
      if (terminal === 'known')
        assert.equal(await second.operations.known(next, reference), true);
      else
        assert.equal(
          await second.operations.rejected(next, 'permission'),
          true,
        );
      await staleWrites();
      assert.equal(await second.operations.uncertain(next), false);
      assert.equal(await f.store.operations.claim(row.id, true), undefined);
      assert.equal((await second.operations.get(row.id)).phase, terminal);
    } finally {
      await second.close();
      await f.dispose();
    }
  }
});
await test('MOCK F1: normal dispatch cannot claim a stale prepared snapshot after uncertainty', async () => {
  const f = await backendFixture();
  try {
    const row = await prepared(f);
    const claim = await f.store.operations.claim(row.id);
    assert.ok(claim);
    assert.equal(await f.store.operations.uncertain(claim), true);
    assert.equal(await f.store.operations.claim(row.id), undefined);
    assert.ok(await f.store.operations.claim(row.id, true));
  } finally {
    await f.dispose();
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
      // The dispatch is at T3, holding its lease, before the lease expires.
      await gate.reached;
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
      const saved = await second.operations.get(id);
      gate.resolve(undefined);
      assert.deepEqual(await pending, {
        kind: 'uncertain',
        operationId: id,
        reason: 'in-flight',
      });
      assert.deepEqual(await second.operations.get(id), saved);
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
      await second.close();
      await f.dispose();
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
    assert.notEqual((await second.operations.get(id)).reference, null);
    expire(f.path, id);
    assert.equal((await backend.reconcile(intent, id)).kind, 'known');
    assert.equal(outbound(wire).length, 0);
    const saved = await second.operations.get(id);
    release.resolve(undefined);
    assert.deepEqual(await pending, {
      kind: 'uncertain',
      operationId: id,
      reason: 'in-flight',
    });
    assert.deepEqual(await second.operations.get(id), saved);
  } finally {
    release.resolve(undefined);
    await pending;
    await second.close();
    await f.dispose();
  }
});

await test(
  'MOCK F1: independent claimant processes have one winner; SIGKILL/reopen recovers unchanged native key',
  { timeout: 15_000 },
  async () => {
    const f = await backendFixture();
    const children: ChildProcess[] = [];
    try {
      const id = await lost(f);
      const original = await f.store.operations.get(id);
      for (let n = 0; n < 2; n++) {
        const child = forkWorker(
          new URL('./fixtures/operation-claimant.ts', import.meta.url),
          [f.path, id],
        );
        children.push(child);
        assert.equal(await message(child), 'ready');
      }
      const results = children.map((child) => message(child));
      for (const child of children) child.send('claim');
      const claims = await Promise.all(results);
      assert.equal(claims.filter((r) => r === 'claimed').length, 1);
      assert.equal(claims.filter((r) => r === 'busy').length, 1);
      assert.deepEqual(await f.backend.reconcile(intent, id), {
        kind: 'uncertain',
        operationId: id,
        reason: 'in-flight',
      });
      for (const child of children) await stop(child, 'SIGKILL');
      await f.store.close();
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
        assert.equal((await reopened.operations.get(id)).generation, 3);
      } finally {
        await reopened.close();
      }
    } finally {
      for (const child of children) await stop(child, 'SIGKILL');
      await f.dispose();
    }
  },
);
