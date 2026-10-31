import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ExecutionFailure } from '../src/domain/execution.js';
import { T3Backend } from '../src/adapters/t3/backend.js';
import { ValidatedTools, ToolList } from '../src/adapters/t3/contracts.js';
import {
  backendFixture,
  MockWire,
  captured,
  envelope,
  launch,
  intent,
  reference,
  options,
  mockRead,
  launched,
} from './t3-helpers.js';
function failure(kind: string) {
  return (error: unknown) =>
    error instanceof ExecutionFailure && error.kind === kind;
}

await test('MOCK: captured v0.1.5 schemas validate inputs and nested authoritative run state', async () => {
  const f = await backendFixture();
  try {
    const result = await f.backend.launch(launch, intent);
    assert.equal(result.kind, 'known');
    const observed = await f.backend.read(reference);
    assert.equal(observed.state, 'succeeded');
    assert.equal(observed.backendStatus, 'completed');
    assert.equal(observed.acceptance, 'not-evaluated');
    const call = f.wire.calls.find((c) => c.name === 't3_thread_launch');
    assert.ok(call);
    assert.equal(call.args.scratch, true);
    assert.equal(call.args.projectId, undefined);
    assert.ok(typeof call.args.clientRequestId === 'string');
  } finally {
    f.dispose();
  }
});
await test('MOCK: explicit project selection is not replaced by linked environmentId', async () => {
  const f = await backendFixture();
  try {
    await f.backend.launch(
      { ...launch, target: { kind: 'project', projectId: 'project-fixture' } },
      intent,
    );
    const call = f.wire.calls.find((c) => c.name === 't3_thread_launch');
    assert.ok(call);
    assert.equal(call.args.projectId, 'project-fixture');
    assert.equal(call.args.scratch, undefined);
    assert.equal(call.args.environmentId, undefined);
  } finally {
    f.dispose();
  }
});
await test('MOCK: unknown version and missing idempotency support fail before mutation', async () => {
  const f = await backendFixture();
  try {
    f.wire.values.t3_environment_read = {
      ...z.record(z.string(), z.unknown()).parse(captured.t3_environment_read),
      serverVersion: '0.1.6',
    };
    await assert.rejects(
      T3Backend.connect(f.wire, f.store.operations, options),
      failure('incompatible'),
    );
    f.wire.values.t3_environment_read = captured.t3_environment_read;
    for (const name of [
      't3_thread_launch',
      't3_thread_send',
      't3_thread_interrupt',
    ]) {
      const list = ToolList.parse(structuredClone(new MockWire().listValue));
      const tool = list.tools.find((t) => t.name === name);
      assert.ok(tool);
      const properties = z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .parse(tool.inputSchema).properties;
      delete properties.clientRequestId;
      tool.inputSchema.properties = properties;
      f.wire.listValue = list;
      await assert.rejects(
        T3Backend.connect(f.wire, f.store.operations, options),
        failure('incompatible'),
      );
    }
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      0,
    );
  } finally {
    f.dispose();
  }
});
await test('MOCK: model/provider and runtime ceilings are checked; tool visibility is not privilege', async () => {
  const f = await backendFixture();
  try {
    await assert.rejects(
      f.backend.launch({ ...launch, mode: 'full-access' }, intent),
      failure('permission'),
    );
    await assert.rejects(
      f.backend.launch(
        { ...launch, model: { providerId: 'unknown', modelId: 'anything' } },
        intent,
      ),
      failure('incompatible'),
    );
    const reader = await T3Backend.connect(f.wire, f.store.operations, {
      ...options,
      scopes: ['orchestration:read'],
    });
    await assert.rejects(reader.launch(launch, intent), failure('permission'));
  } finally {
    f.dispose();
  }
});
await test('MOCK: only typed native capability denial or explicit HTTP auth status is denial evidence', async () => {
  const wire = new MockWire();
  const tools = new ValidatedTools(wire, await wire.list());
  wire.handler = () => Promise.resolve(captured['native-denial']);
  await assert.rejects(
    tools.call('t3_thread_read', { threadId: reference.threadId }),
    failure('permission'),
  );
  wire.handler = () =>
    Promise.reject(new Error('generic network permission-ish message'));
  await assert.rejects(
    tools.call('t3_thread_read', { threadId: reference.threadId }),
    failure('unavailable'),
  );
  wire.handler = () =>
    Promise.reject(Object.assign(new Error('HTTP fixture'), { code: 401 }));
  await assert.rejects(
    tools.call('t3_thread_read', { threadId: reference.threadId }),
    failure('authentication'),
  );
  wire.handler = () =>
    Promise.reject(Object.assign(new Error('HTTP fixture'), { code: 403 }));
  await assert.rejects(
    tools.call('t3_thread_read', { threadId: reference.threadId }),
    failure('permission'),
  );
});
await test('MOCK: malformed nested responses are rejected, not mistaken for completion', async () => {
  const f = await backendFixture();
  try {
    f.wire.values.t3_thread_read = {
      status: 'completed',
      runId: reference.runId,
    };
    await assert.rejects(f.backend.read(reference), failure('incompatible'));
    const tools = new ValidatedTools(f.wire, await f.wire.list());
    const before = f.wire.calls.length;
    await assert.rejects(
      tools.call('t3_thread_read', {}),
      failure('invalid-input'),
    );
    assert.equal(f.wire.calls.length, before);
  } finally {
    f.dispose();
  }
});
await test('MOCK: wait timeout is not terminal; waiting remains nonterminal', async () => {
  const f = await backendFixture();
  try {
    f.wire.values.t3_thread_wait = {
      threadId: reference.threadId,
      runId: reference.runId,
      status: 'completed',
      timedOut: true,
    };
    assert.equal((await f.backend.wait(reference, 1)).kind, 'timeout');
    f.wire.values.t3_thread_wait = {
      threadId: reference.threadId,
      runId: reference.runId,
      status: 'waiting',
      timedOut: false,
    };
    f.wire.values.t3_thread_read = mockRead('waiting');
    const result = await f.backend.wait(reference, 100);
    assert.equal(result.kind, 'observed');
    {
      assert.equal(result.observation.state, 'waiting');
      assert.equal(result.observation.terminal, false);
    }
  } finally {
    f.dispose();
  }
});
await test('MOCK: interrupt_requested requires authoritative terminal reconciliation', async () => {
  const f = await backendFixture();
  try {
    f.wire.values.t3_thread_read = mockRead('running');
    const stopped = await f.backend.stop(reference, intent);
    assert.equal(stopped.kind, 'requested');
    assert.equal(stopped.observation.terminal, false);
    f.wire.values.t3_thread_read = mockRead('interrupted');
    assert.equal((await f.backend.read(reference)).state, 'stopped');
    assert.equal((await f.backend.read(reference)).terminal, true);
  } finally {
    f.dispose();
  }
});
await test('MOCK: run-specific reads do not substitute latest thread status for an unknown run', async () => {
  const f = await backendFixture();
  try {
    assert.equal(
      (await f.backend.read({ ...reference, runId: 'not-in-window' })).state,
      'uncertain',
    );
    assert.equal(
      (await f.backend.read({ ...reference, runId: 'not-in-window' })).terminal,
      false,
    );
    const data = mockRead('running');
    data.recentRuns.push({
      ...data.recentRuns[0],
      runId: launched.runId,
      status: 'completed',
    });
    const newest = data.recentRuns[0];
    assert.ok(newest);
    data.recentRuns[0] = { ...newest, runId: 'newer-run' };
    f.wire.values.t3_thread_read = data;
    assert.equal((await f.backend.read(reference)).state, 'succeeded');
  } finally {
    f.dispose();
  }
});
await test('MOCK: endpoint/linked identities and response thread/run mismatches fail closed', async () => {
  const f = await backendFixture();
  try {
    await assert.rejects(
      T3Backend.connect(f.wire, f.store.operations, {
        ...options,
        expectedEnvironmentId: 'other',
      }),
      failure('incompatible'),
    );
    await assert.rejects(
      T3Backend.connect(f.wire, f.store.operations, {
        ...options,
        linkedEnvironmentId: 'linked-other',
      }),
      failure('incompatible'),
    );
    await assert.rejects(
      f.backend.read({ ...reference, environmentId: 'other' }),
      failure('invalid-input'),
    );
    f.wire.values.t3_thread_wait = {
      threadId: 'other',
      runId: reference.runId,
      status: 'completed',
      timedOut: false,
    };
    await assert.rejects(f.backend.wait(reference, 1), failure('incompatible'));
  } finally {
    f.dispose();
  }
});
await test('MOCK: linked target is passed on every external tool call and resolves its own identity', async () => {
  const f = await backendFixture();
  try {
    f.wire.handler = (name, args) =>
      Promise.resolve(
        envelope(
          name === 't3_environment_read' &&
            args.environmentId === 'linked-fixture'
            ? {
                ...z
                  .record(z.string(), z.unknown())
                  .parse(captured.t3_environment_read),
                environmentId: 'linked-fixture',
              }
            : f.wire.values[name],
        ),
      );
    const linked = await T3Backend.connect(f.wire, f.store.operations, {
      ...options,
      linkedEnvironmentId: 'linked-fixture',
    });
    await linked.read({ ...reference, environmentId: 'linked-fixture' });
    assert.equal(f.wire.calls.at(-1)?.args.environmentId, 'linked-fixture');
  } finally {
    f.dispose();
  }
});
