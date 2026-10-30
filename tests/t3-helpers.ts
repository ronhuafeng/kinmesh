import type { Launch, Reference } from '../src/domain/execution.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Wire } from '../src/adapters/t3/contracts.js';
import { Launched, Descriptor } from '../src/adapters/t3/contracts.js';
import { fixture } from './helpers.js';
import { T3Backend } from '../src/adapters/t3/backend.js';

export const schemas: unknown = JSON.parse(
  readFileSync(
    new URL('./fixtures/t3-0.1.5-tools.json', import.meta.url),
    'utf8',
  ),
);
export const captured = z
  .record(z.string(), z.unknown())
  .parse(
    JSON.parse(
      readFileSync(
        new URL('./fixtures/t3-0.1.5-responses.json', import.meta.url),
        'utf8',
      ),
    ),
  );
export const launched = Launched.parse(captured.t3_thread_launch);
export const environment = Descriptor.parse(captured.t3_environment_read);
const ReadRaw = z.object({
  thread: z.record(z.string(), z.unknown()),
  recentRuns: z.array(z.record(z.string(), z.unknown())),
  items: z.array(z.record(z.string(), z.unknown())),
  nextPosition: z.number().nullable(),
  hasMore: z.boolean(),
});
export function mockRead(status = 'completed') {
  const data = ReadRaw.parse(structuredClone(captured.t3_thread_read));
  return {
    ...data,
    thread: {
      ...data.thread,
      status,
      activeRunId: ['running', 'waiting'].includes(status)
        ? launched.runId
        : null,
      latestRunId: launched.runId,
    },
    recentRuns: [{ ...data.recentRuns[0], runId: launched.runId, status }],
  };
}
export function envelope(value: unknown) {
  return { isError: false, structuredContent: value, content: [] };
}
export class MockWire implements Wire {
  readonly calls: {
    name: string;
    args: Record<string, unknown>;
    signal: AbortSignal | undefined;
  }[] = [];
  listValue: unknown = structuredClone(schemas);
  values: Record<string, unknown> = {
    ...structuredClone(captured),
    t3_thread_read: mockRead(),
    t3_thread_send: {
      ...z.record(z.string(), z.unknown()).parse(captured.t3_thread_send),
      threadId: launched.threadId,
      runId: launched.runId,
    },
    t3_thread_wait: {
      threadId: launched.threadId,
      runId: launched.runId,
      status: 'completed',
      timedOut: false,
    },
    t3_thread_interrupt: {
      threadId: launched.threadId,
      runId: launched.runId,
      status: 'interrupt_requested',
    },
    t3_thread_organize: { sequence: 1 },
  };
  handler:
    | ((name: string, args: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  list() {
    return Promise.resolve(this.listValue);
  }
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    this.calls.push({ name, args, signal });
    return (
      this.handler?.(name, args) ?? Promise.resolve(envelope(this.values[name]))
    );
  }
  close() {
    return Promise.resolve();
  }
}
export const launch = {
  target: { kind: 'scratch' },
  title: 'Mock-only contract',
  model: { providerId: 'codex', modelId: 'gpt-6.1-sol' },
  mode: 'approval-required',
} satisfies Launch;
export const intent = { actor: 'test-owner', operationKey: 'first-launch' };
export const options = {
  endpoint: 'https://t3.invalid/mcp',
  expectedEnvironmentId: environment.environmentId,
  authority: 'test-authority-fingerprint',
  scopes: ['orchestration:read', 'orchestration:operate'],
};
export const reference = {
  backend: 't3',
  environmentId: environment.environmentId,
  threadId: launched.threadId,
  ...(launched.runId === null ? {} : { runId: launched.runId }),
} satisfies Reference;
export async function backendFixture() {
  const f = fixture();
  const store = f.open();
  const wire = new MockWire();
  const backend = await T3Backend.connect(wire, store.operations, options);
  return {
    ...f,
    store,
    wire,
    backend,
    dispose: () => {
      store.close();
      f.cleanup();
    },
  };
}
