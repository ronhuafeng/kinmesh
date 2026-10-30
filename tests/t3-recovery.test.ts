import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { T3Backend } from '../src/adapters/t3/backend.js';
import { ExecutionFailure } from '../src/domain/execution.js';
import {
  backendFixture,
  MockWire,
  envelope,
  launch,
  intent,
  reference,
  options,
} from './t3-helpers.js';

await test('MOCK: intent is durably dispatching before an external effect; repeated known launch makes no new call', async () => {
  const f = await backendFixture();
  try {
    f.wire.handler = (name) => {
      if (name === 't3_thread_launch') {
        const raw = new Database(f.path);
        try {
          assert.equal(
            raw.prepare('SELECT phase FROM execution_operations').pluck().get(),
            'dispatching',
          );
        } finally {
          raw.close();
        }
      }
      return Promise.resolve(envelope(f.wire.values[name]));
    };
    await f.backend.launch(launch, intent);
    await f.backend.launch(launch, intent);
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
  } finally {
    f.dispose();
  }
});
await test('MOCK: lost launch reply survives database reopen and reuses the exact native key', async () => {
  const f = await backendFixture();
  let reopened: ReturnType<typeof f.open> | undefined;
  try {
    f.wire.handler = (name) =>
      name === 't3_thread_launch'
        ? Promise.reject(new Error('Lost reply after effect'))
        : Promise.resolve(envelope(f.wire.values[name]));
    const result = await f.backend.launch(launch, intent);
    assert.equal(result.kind, 'uncertain');
    const original = f.wire.calls.find((c) => c.name === 't3_thread_launch');
    assert.ok(original);
    f.store.close();
    reopened = f.open();
    const wire = new MockWire();
    const backend = await T3Backend.connect(wire, reopened.operations, options);
    const recovered = await backend.reconcile(intent, result.operationId);
    assert.equal(recovered.kind, 'known');
    assert.equal(
      wire.calls.find((c) => c.name === 't3_thread_launch')?.args
        .clientRequestId,
      original.args.clientRequestId,
    );
    assert.deepEqual(recovered.reference, reference);
  } finally {
    reopened?.close();
    f.dispose();
  }
});
await test('MOCK: changed payload, OAuth authority or actor cannot replay an uncertain operation', async () => {
  const f = await backendFixture();
  try {
    f.wire.handler = (name) =>
      name === 't3_thread_launch'
        ? Promise.reject(new Error('Disconnect'))
        : Promise.resolve(envelope(f.wire.values[name]));
    const result = await f.backend.launch(launch, intent);
    assert.equal(result.kind, 'uncertain');
    await assert.rejects(
      f.backend.launch({ ...launch, title: 'different' }, intent),
      (e) => e instanceof ExecutionFailure && e.kind === 'conflict',
    );
    const changed = await T3Backend.connect(f.wire, f.store.operations, {
      ...options,
      authority: 'other-credential',
    });
    await assert.rejects(
      changed.reconcile(intent, result.operationId),
      (e) => e instanceof ExecutionFailure && e.kind === 'conflict',
    );
    await assert.rejects(
      f.backend.reconcile(
        { ...intent, actor: 'someone-else' },
        result.operationId,
      ),
      (e) => e instanceof ExecutionFailure && e.kind === 'permission',
    );
  } finally {
    f.dispose();
  }
});
await test('MOCK: same user operation key is isolated by actor and target endpoint', async () => {
  const f = await backendFixture();
  try {
    await f.backend.launch(launch, intent);
    await f.backend.launch(launch, { ...intent, actor: 'second-owner' });
    const other = await T3Backend.connect(f.wire, f.store.operations, {
      ...options,
      endpoint: 'https://other.invalid/mcp',
    });
    await other.launch(launch, intent);
    const ids = f.wire.calls
      .filter((c) => c.name === 't3_thread_launch')
      .map((c) => c.args.clientRequestId);
    assert.equal(new Set(ids).size, 3);
  } finally {
    f.dispose();
  }
});
await test('MOCK: failure of read after mutation retains a provisional reference and reconciles by read only', async () => {
  const f = await backendFixture();
  try {
    f.wire.handler = (name) =>
      name === 't3_thread_read'
        ? Promise.reject(
            Object.assign(new Error('HTTP fixture'), { code: 401 }),
          )
        : Promise.resolve(envelope(f.wire.values[name]));
    const result = await f.backend.launch(launch, intent);
    assert.equal(result.kind, 'uncertain');
    f.wire.handler = undefined;
    assert.equal(
      (await f.backend.reconcile(intent, result.operationId)).kind,
      'known',
    );
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
  } finally {
    f.dispose();
  }
});
await test('MOCK: concurrent pending calls and explicit permission denial cannot create unkeyed retries', async () => {
  const f = await backendFixture();
  try {
    let release: ((value: unknown) => void) | undefined;
    f.wire.handler = (name) =>
      name === 't3_thread_launch'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(envelope(f.wire.values[name]));
    const first = f.backend.launch(launch, intent);
    const second = await f.backend.launch(launch, intent);
    assert.equal(second.kind, 'uncertain');
    release?.(envelope(f.wire.values.t3_thread_launch));
    await first;
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
  } finally {
    f.dispose();
  }
});
await test('MOCK: cancellation before dispatch has no effect; in-flight cancellation is uncertain', async () => {
  const f = await backendFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.backend.launch(launch, intent, controller.signal),
      (e) => e instanceof ExecutionFailure && e.kind === 'cancelled',
    );
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      0,
    );
    const inFlight = new AbortController();
    f.wire.handler = (name) => {
      if (name === 't3_thread_launch') {
        inFlight.abort();
        return Promise.reject(new Error('Aborted'));
      }
      return Promise.resolve(envelope(f.wire.values[name]));
    };
    const result = await f.backend.launch(launch, intent, inFlight.signal);
    assert.equal(result.kind, 'uncertain');
    assert.equal(result.reason, 'cancelled');
  } finally {
    f.dispose();
  }
});
await test('MOCK: send and stop also persist/reuse stable operation keys', async () => {
  const f = await backendFixture();
  try {
    await f.backend.send(reference, 'followup', intent);
    await f.backend.send(reference, 'followup', intent);
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_send').length,
      1,
    );
    await f.backend.stop(reference, { ...intent, operationKey: 'stop' });
    await f.backend.stop(reference, { ...intent, operationKey: 'stop' });
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_interrupt').length,
      1,
    );
    const raw = new Database(f.path);
    try {
      const rows = z
        .array(z.object({ phase: z.string() }))
        .parse(raw.prepare('SELECT phase FROM execution_operations').all());
      assert.ok(rows.every((r) => r.phase === 'known'));
    } finally {
      raw.close();
    }
  } finally {
    f.dispose();
  }
});
