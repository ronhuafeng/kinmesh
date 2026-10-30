import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Wire } from '../src/adapters/t3/contracts.js';
import { nativeReadOnlyDenial } from '../scripts/t3-native-denial.js';

await test('FIXTURE: only a native MCP capability_denied error proves Read only write rejection', async () => {
  const expected = {
    isError: true,
    structuredContent: { code: 'capability_denied' },
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const wire: Pick<Wire, 'call'> = {
    call(name, args) {
      calls.push({ name, args });
      return Promise.resolve(expected);
    },
  };
  assert.equal(await nativeReadOnlyDenial(wire), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, 't3_thread_organize');
  assert.equal(calls[0]?.args.action, 'archive');
  assert.match(String(calls[0]?.args.threadId), /^[0-9a-f-]{36}$/);
  assert.equal(Object.keys(calls[0]?.args).length, 2);
});

await test('FIXTURE: transport exceptions and local scope errors are not native-denial evidence', async () => {
  const wire: Pick<Wire, 'call'> = {
    call() {
      return Promise.reject(new Error('local permission denied'));
    },
  };
  await assert.rejects(nativeReadOnlyDenial(wire), /local permission denied/);
});

await test('FIXTURE: success, missing isError, and unrelated native errors fail closed', async () => {
  const cases: unknown[] = [
    { isError: false, structuredContent: { code: 'capability_denied' } },
    { structuredContent: { code: 'capability_denied' } },
    { isError: true, structuredContent: { code: 'thread_not_found' } },
    { isError: true, content: [{ type: 'text', text: 'capability_denied' }] },
    { isError: true, structuredContent: null },
    {},
  ];
  for (const value of cases) {
    const wire: Pick<Wire, 'call'> = {
      call() {
        return Promise.resolve(value);
      },
    };
    assert.equal(await nativeReadOnlyDenial(wire), false);
  }
});
