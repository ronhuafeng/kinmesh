import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawDatabase, type RawDatabase } from './raw.js';
import { Correlation } from '../src/domain/agents.js';
import { IdentityError } from '../src/domain/agents.js';
import { FrozenLaunch } from '../src/domain/inbox.js';
import type { Reference } from '../src/domain/execution.js';
import { deliver } from '../src/inbox/worker.js';
import { T3Backend } from '../src/adapters/t3/backend.js';
import {
  inboxFixture,
  due,
  assistantRead,
  fixtureResult,
} from './inbox-helpers.js';
import { postInput, key } from './communication-helpers.js';
import { options, reference, launch } from './t3-helpers.js';

async function prepared() {
  const f = await inboxFixture();
  const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
    .task;
  const claim = await f.inbox.claim([f.agent.id]);
  assert.ok(claim);
  assert.equal(f.workerPrincipal.kind, 'agent');
  await f.inbox.freeze(
    claim,
    f.workerPrincipal,
    FrozenLaunch.parse({
      grantId: f.workerPrincipal.grantId,
      execution: {
        endpoint: options.endpoint,
        environmentId: reference.environmentId,
        authority: options.authority,
      },
      input: launch,
    }),
  );
  await f.inbox.remember(claim, reference);
  return { ...f, task, claim };
}
const counts = (raw: RawDatabase) =>
  [
    'messages',
    'communication_outbox',
    'communication_operations',
    'agent_correlations',
    'agent_runtime_events',
    'agent_audit',
    'task_executions',
    'task_events',
    'inbox_results',
    'inbox_history',
  ].map((table) =>
    raw
      .prepare('SELECT count(*) FROM ' + table)
      .pluck()
      .get(),
  );

for (const other of [
  { name: 'environment', reference: { ...reference, environmentId: 'other' } },
  { name: 'thread', reference: { ...reference, threadId: 'other' } },
  { name: 'Run', reference: { ...reference, runId: 'other' } },
  {
    name: 'thread-only association',
    reference: {
      backend: 't3',
      environmentId: reference.environmentId,
      threadId: reference.threadId,
    },
  },
] satisfies { name: string; reference: Reference }[])
  await test(
    'SQLite: Inbox cannot reuse a correlation for another ' + other.name,
    async () => {
      const f = await prepared();
      const raw = rawDatabase(f.dbPath);
      try {
        const existing = await f.store.agents.correlate(
          f.principal,
          f.teamId,
          f.agent.id,
          {
            reference: other.reference,
            providerSessionId: null,
            invocationId: null,
          },
        );
        await f.inbox.ack(f.claim, f.workerPrincipal, fixtureResult());
        const correlations = await f.store.agents.correlations(
          f.principal,
          f.teamId,
          f.agent.id,
        );
        assert.equal(correlations.length, 2);
        assert.deepEqual(
          correlations.find((c) => c.id === existing.id),
          existing,
        );
        assert.notEqual(
          await raw
            .prepare('SELECT correlation_id FROM inbox_results')
            .pluck()
            .get(),
          existing.id,
        );
        assert.equal((await f.inbox.get(f.claim.id)).state, 'acked');
      } finally {
        await raw.close();
        await f.dispose();
      }
    },
  );

for (const denied of [
  'other-agent',
  'revoked',
  'removed',
  'expired-lease',
] as const)
  await test(
    'SQLite: existing correlation cannot bypass Inbox ownership/authority/fence: ' +
      denied,
    async () => {
      const f = await prepared();
      const raw = rawDatabase(f.dbPath);
      try {
        const existing = await f.store.agents.correlate(
          f.principal,
          f.teamId,
          denied === 'other-agent' ? f.reviewer.id : f.agent.id,
          {
            reference,
            providerSessionId: null,
            invocationId: 'prior-invocation',
          },
        );
        if (denied === 'revoked')
          await f.store.agents.revoke(
            f.principal,
            f.teamId,
            f.agent.id,
            f.inboxGrant.grant.id,
          );
        if (denied === 'removed')
          await f.comm.enroll(
            f.principal,
            f.teamId,
            f.channelId,
            {
              operationKey: key(),
              member: { kind: 'agent', id: f.agent.id },
            },
            'remove',
          );
        if (denied === 'expired-lease') await due(f.dbPath, true);
        const before = counts(raw);
        await assert.rejects(
          async () => f.inbox.ack(f.claim, f.workerPrincipal, fixtureResult()),
          IdentityError,
        );
        assert.deepEqual(counts(raw), before);
        assert.equal((await f.inbox.get(f.claim.id)).resultMessageId, null);
        assert.deepEqual(
          await f.store.agents.correlations(
            f.principal,
            f.teamId,
            existing.agentId,
          ),
          [existing],
        );
      } finally {
        await raw.close();
        await f.dispose();
      }
    },
  );

for (const failedTable of ['inbox_results', 'inbox_history'])
  await test(
    'SQLite: reuse of an existing correlation remains atomic at ' + failedTable,
    async () => {
      const f = await prepared();
      const raw = rawDatabase(f.dbPath);
      try {
        const existing = await f.store.agents.correlate(
          f.principal,
          f.teamId,
          f.agent.id,
          {
            reference,
            providerSessionId: 'retained-provider-session',
            invocationId: 'retained-invocation',
          },
        );
        const before = counts(raw);
        await raw.exec(
          'CREATE TRIGGER reject_correlated_ack BEFORE INSERT ON ' +
            failedTable +
            " BEGIN SELECT RAISE(ABORT,'fixture'); END",
        );
        await assert.rejects(async () =>
          f.inbox.ack(f.claim, f.workerPrincipal, fixtureResult()),
        );
        assert.deepEqual(counts(raw), before);
        assert.equal((await f.inbox.get(f.claim.id)).resultMessageId, null);
        await raw.exec('DROP TRIGGER reject_correlated_ack');
        await f.inbox.ack(f.claim, f.workerPrincipal, fixtureResult());
        assert.equal((await f.inbox.get(f.claim.id)).state, 'acked');
        assert.deepEqual(
          await f.store.agents.correlations(f.principal, f.teamId, f.agent.id),
          [existing],
        );
        assert.equal(
          await raw
            .prepare('SELECT count(*) FROM agent_runtime_events')
            .pluck()
            .get(),
          1,
        );
        assert.equal(
          await raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
          1,
        );
        assert.equal(
          await raw
            .prepare('SELECT correlation_id FROM inbox_results')
            .pluck()
            .get(),
          existing.id,
        );
        await assert.rejects(
          async () => f.inbox.ack(f.claim, f.workerPrincipal, fixtureResult()),
          IdentityError,
        );
      } finally {
        await raw.close();
        await f.dispose();
      }
    },
  );

for (const status of ['completed', 'failed'] as const)
  await test(`MOCK SQLite: a Run correlated through the execution API recovers Inbox ACK after restart (${status})`, async () => {
    const f = await inboxFixture();
    const raw = rawDatabase(f.dbPath);
    try {
      const task = (
        await f.create({ owner: { kind: 'agent', id: f.agent.id } })
      ).task;
      f.wire.values.t3_thread_read = assistantRead('MOCK pending', 'waiting');
      const first = await f.inbox.claim([f.agent.id]);
      assert.ok(first);
      await deliver(
        f.store,
        first,
        f.binding,
        f.factory,
        new AbortController().signal,
      );
      const frozen = await f.inbox.get(first.id);
      assert.equal(frozen.state, 'waiting');
      assert.equal(frozen.reference, JSON.stringify(reference));

      // This public API is independent of Inbox publication. Its immutable
      // provenance and provider metadata must survive recovery unchanged.
      const response = await f.app.inject({
        method: 'POST',
        url: `/api/teams/${f.teamId}/agents/${f.agent.id}/executions`,
        ...(status === 'completed'
          ? { cookies: f.cookies }
          : { headers: { authorization: 'Bearer ' + f.inboxGrant.token } }),
        payload: {
          reference,
          providerSessionId: 'mock-provider-session',
          invocationId: 'mock-existing-invocation',
        },
      });
      assert.equal(response.statusCode, 201);
      const existing = Correlation.parse(response.json<unknown>());
      await f.comm.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
      );
      assert.equal(await f.inbox.claim([f.agent.id]), undefined);

      const terminal = assistantRead('MOCK recovered assistant result', status);
      if (status === 'failed') terminal.items = [];
      f.wire.values.t3_thread_read = terminal;
      await due(f.dbPath);
      const reopened = await f.open();
      try {
        const recovered = await reopened.inbox.claim([f.agent.id]);
        assert.ok(recovered);
        assert.equal(recovered.id, first.id);
        const backend = await T3Backend.connect(
          f.wire,
          reopened.operations,
          options,
        );
        await deliver(
          reopened,
          recovered,
          f.binding,
          () =>
            Promise.resolve({
              backend,
              identity: {
                endpoint: options.endpoint,
                environmentId: reference.environmentId,
                authority: options.authority,
              },
              close: () => f.wire.close(),
            }),
          new AbortController().signal,
        );
        const row = await reopened.inbox.get(first.id);
        assert.equal(
          row.state,
          'acked',
          'An existing same-agent correlation must not strand publication and the agent queue',
        );
        assert.equal(row.launch, frozen.launch);
        assert.equal(row.reference, frozen.reference);
        assert.ok(row.resultMessageId);
        const message = await reopened.communication.message(
          f.principal,
          f.teamId,
          f.channelId,
          row.resultMessageId,
        );
        assert.equal(message.sourceEventId, first.eventId);
        assert.equal(message.author.kind, 'agent');
        assert.equal(message.author.agentId, f.agent.id);
        assert.ok(
          message.body.startsWith(
            status === 'completed'
              ? 'MOCK recovered assistant result'
              : 'The run in T3 failed before writing a reply.',
          ),
        );
        assert.deepEqual(
          await reopened.agents.correlations(f.principal, f.teamId, f.agent.id),
          [existing],
        );
        assert.equal(
          await raw
            .prepare('SELECT correlation_id FROM inbox_results')
            .pluck()
            .get(),
          existing.id,
        );
        assert.equal(
          await raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
          1,
        );
        assert.equal(
          (
            await reopened.agents.runtimeEvents(
              f.principal,
              f.teamId,
              f.agent.id,
              existing.id,
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await reopened.tasks.get(
              f.principal,
              f.teamId,
              f.channelId,
              task.id,
            )
          ).state.status,
          'in-progress',
        );
        assert.equal(
          f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
          1,
          'Recovery must only read the remembered Run',
        );
        const next = await reopened.inbox.claim([f.agent.id]);
        assert.ok(next);
        assert.notEqual(next.id, first.id);
      } finally {
        await reopened.close();
      }
    } finally {
      await raw.close();
      await f.dispose();
    }
  });
