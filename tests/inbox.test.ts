import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawDatabase } from './raw.js';
import { randomUUID } from 'node:crypto';
import { AgentId } from '../src/domain/contracts.js';
import { writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  Claim,
  FrozenLaunch,
  INBOX_CAPACITY,
  retryDelay,
} from '../src/domain/inbox.js';
import { IdentityError } from '../src/domain/agents.js';
import { deliver, assistantResult } from '../src/inbox/worker.js';
import { loadWorkerConfig, WorkerConfig } from '../src/inbox/config.js';
import { t3Factory } from '../src/inbox/t3.js';
import { T3Backend } from '../src/adapters/t3/backend.js';
import { postInput, key } from './communication-helpers.js';
import { profileInput } from './agent-helpers.js';
import {
  inboxFixture,
  due,
  fixtureResult,
  assistantRead,
} from './inbox-helpers.js';
import {
  options,
  launch,
  reference,
  envelope,
  mockRead,
} from './t3-helpers.js';
const signal = () => new AbortController().signal;
const mention = async (
  f: Awaited<ReturnType<typeof inboxFixture>>,
  body = 'Human asks for a response',
) =>
  f.comm.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({ body, mentions: [{ kind: 'agent', id: f.agent.id }] }),
  );
async function claim(f: Awaited<ReturnType<typeof inboxFixture>>) {
  const c = await f.inbox.claim([f.agent.id]);
  assert.ok(c);
  return c;
}
async function freeze(
  f: Awaited<ReturnType<typeof inboxFixture>>,
  c: Claim,
  executionReference = reference,
) {
  assert.equal(f.workerPrincipal.kind, 'agent');
  const p = f.workerPrincipal;
  assert.equal(p.kind, 'agent');
  await f.inbox.freeze(
    c,
    p,
    FrozenLaunch.parse({
      grantId: p.grantId,
      execution: {
        endpoint: options.endpoint,
        environmentId: reference.environmentId,
        authority: options.authority,
      },
      input: { ...launch, message: 'Frozen fixture input' },
    }),
  );
  await f.inbox.remember(c, executionReference);
}
await test('inbox enqueue and outbox/receipt are atomic; exact replay is once and collision fails', async () => {
  const f = await inboxFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    const input = postInput({
      mentions: [{ kind: 'agent', id: f.agent.id }],
    });
    const message = await f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      input,
    );
    assert.equal(
      (await f.comm.post(f.principal, f.teamId, f.channelId, input)).id,
      message.id,
    );
    assert.equal((await f.rows()).length, 1);
    await assert.rejects(
      () =>
        f.comm.post(f.principal, f.teamId, f.channelId, {
          ...input,
          body: 'Different',
        }),
      IdentityError,
    );
    const counts = () =>
      Promise.all(
        [
          'messages',
          'communication_outbox',
          'communication_operations',
          'agent_inbox',
          'inbox_history',
          'tasks',
          'task_events',
        ].map((t) =>
          raw
            .prepare('SELECT count(*) FROM ' + t)
            .pluck()
            .get(),
        ),
      );
    const before = await counts();
    await raw.trigger('reject_inbox', 'agent_inbox');
    await assert.rejects(() => mention(f));
    assert.deepEqual(await counts(), before);
    await assert.rejects(() =>
      f.create({ owner: { kind: 'agent', id: f.agent.id } }),
    );
    assert.deepEqual(await counts(), before);
  } finally {
    await raw.close();
    await f.dispose();
  }
});
await test('MOCK external adapter: exact-run actual assistant is attributed and ACK/message/outbox/task/correlation commit together without acceptance', async () => {
  const f = await inboxFixture();
  try {
    const source = await mention(f);
    const c = await claim(f);
    await deliver(f.store, c, f.binding, f.factory, signal());
    const row = await f.inbox.get(c.id);
    assert.equal(row.state, 'acked');
    assert.ok(row.resultMessageId);
    const message = await f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      row.resultMessageId,
    );
    assert.ok(
      message.body.startsWith(
        'Fixture assistant output; no real model was invoked.',
      ),
    );
    assert.equal(message.author.kind, 'agent');
    assert.equal(message.author.agentId, f.agent.id);
    assert.equal(message.sourceMessageId, source.id);
    assert.equal(message.sourceEventId, c.eventId);
    // The reply is the answer only; where it came from is projected beside it.
    assert.equal(
      message.body,
      'Fixture assistant output; no real model was invoked.',
    );
    const [reply] = await f.store.inboxViews.repliesFor(
      f.principal,
      f.teamId,
      f.channelId,
      [message.id],
    );
    assert.ok(reply);
    assert.equal(reply.runId, reference.runId);
    assert.equal(reply.state, 'succeeded');
    assert.equal(reply.answered, true);
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
    assert.equal(
      (await f.rows()).length,
      1,
      'result has no mentions, cannot wake itself',
    );
    assert.equal(await f.inbox.claim([f.agent.id]), undefined);
    const reopened = await f.open();
    try {
      assert.equal(
        (await reopened.inbox.get(c.id)).resultMessageId,
        message.id,
      );
      assert.equal(
        (await reopened.agents.correlations(f.principal, f.teamId, f.agent.id))
          .length,
        1,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.dispose();
  }
});
for (const status of ['completed', 'failed'] as const)
  await test(`MOCK SQLite recovery: an agent-prelinked exact Run publishes once after restart (${status})`, async () => {
    const f = await inboxFixture();
    const raw = rawDatabase(f.dbPath);
    try {
      const task = (
        await f.create({ owner: { kind: 'agent', id: f.agent.id } })
      ).task;
      f.wire.values.t3_thread_read = assistantRead('MOCK pending', 'waiting');
      const first = await claim(f);
      await deliver(f.store, first, f.binding, f.factory, signal());
      const frozen = await f.inbox.get(first.id);
      assert.equal(frozen.state, 'waiting');
      assert.equal(frozen.reference, JSON.stringify(reference));
      // This is the same authorized command exposed by team_task_link_execution.
      // A provider may record its execution evidence before returning its result.
      const linked = await f.act(f.developer, task, {
        type: 'link-execution',
        reference,
        note: 'MOCK provider recorded its current Run before completion',
      });
      assert.ok(linked.executionLink);
      await mention(
        f,
        'A later request must not be blocked by existing evidence',
      );
      assert.equal(await f.inbox.claim([f.agent.id]), undefined);
      const terminal = assistantRead('MOCK exact-run recovered result', status);
      if (status === 'failed') terminal.items = [];
      f.wire.values.t3_thread_read = terminal;
      await due(f.dbPath);
      const reopened = await f.open();
      try {
        const recovered = await reopened.inbox.claim([f.agent.id]);
        assert.ok(recovered);
        assert.equal(recovered.id, first.id);
        await deliver(reopened, recovered, f.binding, f.factory, signal());
        const row = await reopened.inbox.get(first.id);
        assert.equal(
          row.state,
          'acked',
          'Existing task evidence must not strand Inbox publication',
        );
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
            status === 'failed'
              ? 'The run in T3 failed before writing a reply.'
              : 'MOCK exact-run recovered result',
          ),
        );
        assert.equal(row.launch, frozen.launch);
        assert.equal(row.reference, frozen.reference);
        assert.equal(
          await raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
          1,
        );
        assert.equal(
          await raw
            .prepare('SELECT task_link_id FROM inbox_results')
            .pluck()
            .get(),
          linked.executionLink.id,
        );
        assert.equal(
          await raw
            .prepare('SELECT count(*) FROM agent_correlations')
            .pluck()
            .get(),
          1,
        );
        assert.deepEqual(
          (
            await reopened.tasks.executions(
              f.principal,
              f.teamId,
              f.channelId,
              task.id,
            )
          ).items,
          [linked.executionLink],
          'Reuse immutable evidence without changing its original author or duplicating it',
        );
        const current = await reopened.tasks.get(
          f.principal,
          f.teamId,
          f.channelId,
          task.id,
        );
        assert.equal(current.version, linked.task.version);
        assert.equal(current.state.status, 'in-progress');
        await assert.rejects(
          async () =>
            reopened.inbox.ack(recovered, f.workerPrincipal, fixtureResult()),
          IdentityError,
        );
        const following = await reopened.inbox.claim([f.agent.id]);
        assert.ok(following);
        assert.notEqual(following.id, first.id);
        assert.equal(
          f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
          1,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await raw.close();
      await f.dispose();
    }
  });
await test('MOCK publication reuses only the same task and exact Run, not nearby execution evidence', async () => {
  const f = await inboxFixture();
  try {
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const otherRun = await f.act(f.developer, task, {
      type: 'link-execution',
      reference: { ...reference, runId: 'different-mock-run' },
      note: 'MOCK other Run on the same task',
    });
    const otherTask = (
      await f.create({
        owner: { kind: 'agent', id: f.agent.id },
      })
    ).task;
    const otherLink = await f.act(f.developer, otherTask, {
      type: 'link-execution',
      reference,
      note: 'MOCK matching Run on a different task',
    });
    const c = await claim(f);
    await deliver(f.store, c, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(c.id)).state, 'acked');
    const links = (
      await f.tasks.executions(f.principal, f.teamId, f.channelId, task.id)
    ).items;
    assert.equal(links.length, 2);
    const published = links.find(
      (link) => link.reference.runId === reference.runId,
    );
    assert.ok(published);
    assert.notEqual(published.id, otherRun.executionLink?.id);
    assert.notEqual(published.id, otherLink.executionLink?.id);
    assert.deepEqual(published.reference, reference);
    assert.equal(
      (await f.tasks.get(f.principal, f.teamId, f.channelId, task.id)).version,
      otherRun.task.version,
    );
  } finally {
    await f.dispose();
  }
});
await test('MOCK native terminal failure without assistant posts truthful notice and releases the same-agent queue', async () => {
  const f = await inboxFixture();
  try {
    const source = await mention(f);
    const failed = mockRead('failed');
    failed.items = [];
    // The exact Run failed even though a DIFFERENT later Run in its thread
    // is now waiting for approval; thread pending count is not Run-scoped.
    const newerRun = 'later-pending-run';
    const oldRun = failed.recentRuns[0];
    assert.ok(oldRun);
    failed.recentRuns.unshift({
      ...oldRun,
      runId: newerRun,
      status: 'waiting',
    });
    Object.assign(failed.thread, {
      status: 'waiting',
      activeRunId: newerRun,
      latestRunId: newerRun,
      pendingRequestCount: 1,
    });
    f.wire.values.t3_thread_read = failed;
    const c = await claim(f);
    await deliver(f.store, c, f.binding, f.factory, signal());
    const row = await f.inbox.get(c.id);
    assert.equal(row.state, 'acked');
    assert.equal(row.reason, 'native-terminal-notice-published');
    assert.ok(row.resultMessageId);
    const notice = await f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      row.resultMessageId,
    );
    // Said plainly, never dressed up as the agent's answer.
    assert.equal(notice.body, 'The run in T3 failed before writing a reply.');
    const [status] = await f.store.inboxViews.repliesFor(
      f.principal,
      f.teamId,
      f.channelId,
      [notice.id],
    );
    assert.ok(status);
    assert.equal(status.state, 'failed');
    assert.equal(status.answered, false);
    assert.equal(notice.sourceMessageId, source.id);
    assert.equal(notice.sourceEventId, c.eventId);
    assert.equal(notice.author.kind, 'agent');
    assert.equal(notice.author.agentId, f.agent.id);
    const reopened = await f.open();
    try {
      assert.equal((await reopened.inbox.get(c.id)).state, 'acked');
      assert.equal(
        (await reopened.agents.correlations(f.principal, f.teamId, f.agent.id))
          .length,
        1,
      );
    } finally {
      await reopened.close();
    }
    await mention(f, 'Second independently authorized human request');
    const following = await claim(f);
    assert.notEqual(following.id, c.id);
    const backend = await T3Backend.connect(
      f.wire,
      f.store.operations,
      options,
    );
    const interrupted = mockRead('interrupted');
    interrupted.items = [];
    const newerRun2 = 'even-later-pending-run';
    const stoppedRun = interrupted.recentRuns[0];
    assert.ok(stoppedRun);
    interrupted.recentRuns.unshift({
      ...stoppedRun,
      runId: newerRun2,
      status: 'waiting',
    });
    Object.assign(interrupted.thread, {
      status: 'waiting',
      activeRunId: newerRun2,
      latestRunId: newerRun2,
      pendingRequestCount: 1,
    });
    f.wire.values.t3_thread_read = interrupted;
    const stopped = await assistantResult(
      backend,
      reference,
      launch.model,
      signal(),
    );
    if (stopped.kind !== 'terminal-notice')
      throw new Error('Expected native terminal status notice');
    assert.equal(stopped.notice.kind, 'native-terminal-no-assistant');
    assert.equal(stopped.notice.state, 'stopped');

    // A completed older Run must still publish the actual assistant item
    // while another Run in the same thread is waiting for human approval.
    const completed = mockRead('completed');
    const newerRun3 = 'yet-another-waiting-run';
    const completedRun = completed.recentRuns[0];
    assert.ok(completedRun);
    completed.recentRuns.unshift({
      ...completedRun,
      runId: newerRun3,
      status: 'waiting',
    });
    Object.assign(completed.thread, {
      status: 'waiting',
      activeRunId: newerRun3,
      latestRunId: newerRun3,
      pendingRequestCount: 1,
    });
    f.wire.values.t3_thread_read = completed;
    const actual = await assistantResult(
      backend,
      reference,
      launch.model,
      signal(),
    );
    if (actual.kind !== 'result')
      throw new Error('Expected the exact completed Run assistant result');
    assert.equal(actual.result.reference.runId, reference.runId);
    assert.equal(actual.result.text, 'fixture-redacted');
  } finally {
    await f.dispose();
  }
});
for (const { failedTable, prelinked } of [
  'communication_outbox',
  'inbox_results',
  'inbox_history',
].flatMap((failedTable) => [
  { failedTable, prelinked: false },
  { failedTable, prelinked: true },
]))
  await test(
    'ACK rollback at ' +
      failedTable +
      ' leaves no partial result/link/audit/receipt' +
      (prelinked ? ' with prelinked Run' : ''),
    async () => {
      const f = await inboxFixture();
      const raw = rawDatabase(f.dbPath);
      try {
        const task = (
          await f.create({
            owner: { kind: 'agent', id: f.agent.id },
          })
        ).task;
        const c = await claim(f);
        await freeze(f, c);
        if (prelinked)
          await f.act(f.developer, task, {
            type: 'link-execution',
            reference,
            note: 'MOCK existing link survives failed ACK',
          });
        const beforeTask = await f.tasks.get(
          f.principal,
          f.teamId,
          f.channelId,
          task.id,
        );
        const tables = [
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
        ];
        const counts = () =>
          Promise.all(
            tables.map((t) =>
              raw
                .prepare('SELECT count(*) FROM ' + t)
                .pluck()
                .get(),
            ),
          );
        const before = await counts();
        await raw.trigger(
          'reject_ack',
          failedTable,
          undefined,
          failedTable === 'inbox_history'
            ? "NEW.reason = 'assistant-result-published'"
            : undefined,
        );
        await assert.rejects(async () =>
          f.inbox.ack(c, f.workerPrincipal, fixtureResult()),
        );
        assert.deepEqual(await counts(), before);
        assert.equal((await f.inbox.get(c.id)).state, 'ready');
        assert.equal(
          (await f.tasks.get(f.principal, f.teamId, f.channelId, task.id))
            .version,
          prelinked ? 2 : 1,
        );
        await raw.dropTrigger('reject_ack', failedTable);
        const result = await f.inbox.ack(c, f.workerPrincipal, fixtureResult());
        assert.equal((await f.inbox.get(c.id)).resultMessageId, result.id);
        const current = await f.tasks.get(
          f.principal,
          f.teamId,
          f.channelId,
          task.id,
        );
        assert.deepEqual(current, beforeTask);
        assert.equal(
          (
            await f.tasks.executions(
              f.principal,
              f.teamId,
              f.channelId,
              task.id,
            )
          ).items.length,
          1,
        );
        await assert.rejects(
          async () => f.inbox.ack(c, f.workerPrincipal, fixtureResult()),
          IdentityError,
        );
        assert.equal(
          await raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
          1,
        );
      } finally {
        await raw.close();
        await f.dispose();
      }
    },
  );
for (const denied of [
  'disabled',
  'revoked',
  'removed',
  'scope',
  'cross-team',
  'wrong-agent',
  'reassigned',
] as const)
  await test('current dispatch authority fails closed: ' + denied, async () => {
    const f = await inboxFixture();
    const raw = rawDatabase(f.dbPath);
    try {
      if (denied === 'reassigned')
        await f.create({ owner: { kind: 'agent', id: f.agent.id } });
      else await mention(f);
      const c = await claim(f);
      if (denied === 'disabled')
        await f.store.agents.lifecycle(
          f.principal,
          f.teamId,
          f.agent.id,
          'disabled',
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
      if (denied === 'scope') {
        const g = await f.store.agents.issue(
          f.principal,
          f.teamId,
          f.agent.id,
          {
            label: 'Insufficient',
            scopes: ['channels:read'],
            lifetimeSeconds: 3600,
          },
        );
        writeFileSync(f.binding.tokenFile, JSON.stringify({ token: g.token }), {
          mode: 0o600,
        });
      }
      if (denied === 'cross-team') {
        await assert.rejects(
          () =>
            f.inbox.context(
              Claim.parse({ ...c, teamId: randomUUID() }),
              f.workerPrincipal,
            ),
          IdentityError,
        );
        return;
      }
      if (denied === 'wrong-agent') {
        await assert.rejects(
          () => f.inbox.context(c, f.reviewPrincipal),
          IdentityError,
        );
        return;
      }
      if (denied === 'reassigned') {
        assert.ok(c.taskId);
        const task = await f.tasks.get(
          f.principal,
          f.teamId,
          f.channelId,
          c.taskId,
        );
        await f.act(f.principal, task, {
          type: 'handoff',
          mode: 'work',
          recipient: { kind: 'agent', id: f.reviewer.id },
          note: 'Human transfer',
        });
      }
      await deliver(f.store, c, f.binding, f.factory, signal());
      assert.equal((await f.inbox.get(c.id)).state, 'blocked');
      assert.equal(f.wire.calls.length, 0);
      assert.equal(
        await raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
        0,
      );
    } finally {
      await raw.close();
      await f.dispose();
    }
  });
await test('revocation after launch prevents publication and retains native reference for operator reconciliation', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    const c = await claim(f);
    f.wire.handler = async (name) => {
      if (name === 't3_thread_read')
        await f.store.agents.revoke(
          f.principal,
          f.teamId,
          f.agent.id,
          f.inboxGrant.grant.id,
        );
      return Promise.resolve(envelope(f.wire.values[name]));
    };
    await deliver(f.store, c, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(c.id)).state, 'blocked');
    assert.notEqual((await f.inbox.get(c.id)).reference, null);
    assert.equal((await f.inbox.get(c.id)).resultMessageId, null);
  } finally {
    await f.dispose();
  }
});
await test('context is bounded, source-attributed, preserves topic/task/memory reference and is frozen once', async () => {
  const f = await inboxFixture();
  try {
    const topic = await f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'A topic',
    });
    const task = (
      await f.create({
        topicId: topic.id,
        owner: { kind: 'agent', id: f.agent.id },
        description: 'd'.repeat(4000),
        criteria: Array.from(
          { length: 20 },
          (_, i) => String(i) + 'c'.repeat(400),
        ),
      })
    ).task;
    const c = await claim(f);
    const { context } = await f.inbox.context(c, f.workerPrincipal);
    assert.equal(context.task?.id, task.id);
    assert.equal(context.topic?.id, topic.id);
    assert.equal(context.author.kind, 'human');
    assert.equal(context.memoryLocation, profileInput.memoryLocation);
    assert.equal(context.task.truncated, true);
    assert.ok(JSON.stringify(context).length < 10000);
    await freeze(f, c);
    const old = (await f.inbox.get(c.id)).launch;
    const p = f.workerPrincipal;
    assert.equal(p.kind, 'agent');
    const same = await f.inbox.freeze(c, p, {
      grantId: p.grantId,
      execution: {
        endpoint: options.endpoint,
        environmentId: reference.environmentId,
        authority: options.authority,
      },
      input: { ...launch, message: 'Changed untrusted source' },
    });
    assert.equal(JSON.stringify(same), old);
  } finally {
    await f.dispose();
  }
});
await test('uncertain launch uses explicit reconciliation and identical native request ID after restart; no blind dispatch', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    const c = await claim(f);
    f.wire.handler = (name) =>
      name === 't3_thread_launch'
        ? Promise.reject(new Error('Fixture lost reply'))
        : Promise.resolve(envelope(f.wire.values[name]));
    await deliver(f.store, c, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(c.id)).state, 'uncertain');
    assert.ok((await f.inbox.get(c.id)).operationId);
    const first = f.wire.calls.find((c) => c.name === 't3_thread_launch')?.args
      .clientRequestId;
    await due(f.dbPath);
    f.wire.handler = undefined;
    const reopened = await f.open();
    try {
      const backend = await T3Backend.connect(
        f.wire,
        reopened.operations,
        options,
      );
      const recovered = await reopened.inbox.claim([f.agent.id]);
      assert.ok(recovered);
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
        signal(),
      );
      assert.equal((await reopened.inbox.get(c.id)).state, 'acked');
      const calls = f.wire.calls.filter((c) => c.name === 't3_thread_launch');
      assert.equal(calls.length, 2);
      assert.ok(calls.every((c) => c.args.clientRequestId === first));
    } finally {
      await reopened.close();
    }
  } finally {
    await f.dispose();
  }
});
await test('native connection unavailable keeps retryable work with bounded backoff and no retry exhaustion', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    for (let i = 0; i < 12; i++) {
      const c = await claim(f);
      await deliver(
        f.store,
        c,
        f.binding,
        () => Promise.reject(new Error('External unavailable')),
        signal(),
      );
      const row = await f.inbox.get(c.id);
      assert.equal(row.state, 'ready');
      assert.ok(row.nextAttempt > Date.now() - 100);
      assert.equal(row.resultMessageId, null);
      await due(f.dbPath);
    }
    assert.equal((await f.rows())[0]?.attempts, 12);
    assert.equal(retryDelay(100000), 300000);
    assert.equal(f.wire.calls.length, 0);
  } finally {
    await f.dispose();
  }
});
await test('leases fence every stale write and ACK; global capacity and per-agent order hold across connections', async () => {
  const f = await inboxFixture();
  const other = await f.open();
  const raw = rawDatabase(f.dbPath);
  try {
    await mention(f);
    await mention(f);
    const c = await claim(f);
    await freeze(f, c);
    assert.equal(await other.inbox.claim([f.agent.id]), undefined);
    await due(f.dbPath, true);
    await assert.rejects(async () => {
      await f.inbox.remember(c, reference);
    }, IdentityError);
    await assert.rejects(async () => {
      await f.inbox.defer(c, 'ready', 'stale');
    }, IdentityError);
    await assert.rejects(
      async () => f.inbox.ack(c, f.workerPrincipal, fixtureResult()),
      IdentityError,
    );
    const next = await other.inbox.claim([f.agent.id]);
    assert.ok(next);
    assert.equal(next.id, c.id);
    assert.equal(next.generation, c.generation + 1);
    await assert.rejects(
      () =>
        f.inbox.freeze(
          c,
          f.workerPrincipal,
          FrozenLaunch.parse({
            grantId: f.inboxGrant.grant.id,
            execution: {
              endpoint: options.endpoint,
              environmentId: reference.environmentId,
              authority: options.authority,
            },
            input: launch,
          }),
        ),
      IdentityError,
    );
    await other.inbox.ack(next, f.workerPrincipal, fixtureResult());
    assert.ok(await f.inbox.claim([f.agent.id]));
    assert.equal(INBOX_CAPACITY, 2);
    await assert.rejects(() => raw.exec('DELETE FROM inbox_history'));
    await assert.rejects(() =>
      raw.exec("UPDATE agent_inbox SET event_id='rewritten'"),
    );
    await assert.rejects(() => raw.exec('DELETE FROM agent_inbox'));
  } finally {
    await raw.close();
    await other.close();
    await f.dispose();
  }
});
for (const recovery of ['release', 'expired-lease'] as const)
  await test(`MOCK recovery: resumed older delivery waits for a newer same-agent lease (${recovery})`, async () => {
    const f = await inboxFixture();
    const other = await f.open();
    const raw = rawDatabase(f.dbPath);
    try {
      await mention(f, 'Older request to recover');
      const older = await claim(f);
      await freeze(f, older);
      await f.inbox.defer(older, 'blocked', 'fixture-blocked');
      const frozen = await f.inbox.get(older.id);

      await mention(f, 'Newer request already being processed');
      const newer = await other.inbox.claim([f.agent.id]);
      assert.ok(newer);
      assert.notEqual(newer.id, older.id);
      const newerReference = {
        ...reference,
        threadId: 'fixture-newer-thread',
        runId: 'fixture-newer-run',
      };
      const newerResult = {
        ...fixtureResult(),
        reference: newerReference,
      };
      await freeze(f, newer, newerReference);
      await f.inbox.resume(older.id);

      assert.equal(
        await f.inbox.claim([f.agent.id]),
        undefined,
        'Resuming an older row must not overlap a live newer same-agent lease',
      );
      assert.equal(await other.inbox.claim([f.agent.id]), undefined);
      assert.equal((await f.inbox.get(newer.id)).claimToken, newer.claimToken);

      // The exclusion is per agent: another agent can use the remaining slot.
      await f.comm.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({ mentions: [{ kind: 'agent', id: f.reviewer.id }] }),
      );
      const independent = await other.inbox.claim([f.reviewer.id]);
      assert.ok(independent);
      await other.inbox.defer(independent, 'blocked', 'fixture-blocked');

      if (recovery === 'release')
        await other.inbox.defer(newer, 'waiting', 'fixture-waiting');
      else {
        // Deterministic crash/clock fixture; no native T3 service or timers.
        await raw
          .prepare('UPDATE agent_inbox SET lease_until=1 WHERE id=?')
          .run(newer.id);
        await assert.rejects(
          () => other.inbox.ack(newer, f.workerPrincipal, newerResult),
          IdentityError,
        );
      }
      const recovered = await other.inbox.claim([f.agent.id]);
      assert.ok(recovered);
      assert.equal(recovered.id, older.id);
      assert.equal(recovered.generation, older.generation + 1);
      assert.equal(recovered.launch, frozen.launch);
      assert.equal(recovered.reference, frozen.reference);
      assert.equal(await f.inbox.claim([f.agent.id]), undefined);
      await other.inbox.ack(recovered, f.workerPrincipal, fixtureResult());

      await due(f.dbPath);
      const following = await claim(f);
      assert.equal(following.id, newer.id);
      assert.equal(following.generation, newer.generation + 1);
      assert.equal(following.reference, JSON.stringify(newerReference));
      await f.inbox.ack(following, f.workerPrincipal, newerResult);
      assert.equal((await f.inbox.get(older.id)).state, 'acked');
      assert.equal((await f.inbox.get(newer.id)).state, 'acked');
      assert.equal(
        await raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
        2,
      );
      assert.equal(f.wire.calls.length, 0, 'Persistence-only MOCK evidence');
    } finally {
      await raw.close();
      await other.close();
      await f.dispose();
    }
  });
await test('agent handoffs follow trusted audit chain, one target per chain, finite budget; human intervention resets it', async () => {
  const f = await inboxFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    const members = [f.agent];
    for (let i = 1; i < 6; i++) {
      const a = await f.store.agents.create(f.principal, f.teamId, {
        ...profileInput,
        name: 'Chain ' + String(i),
      });
      members.push(a);
      await f.comm.enroll(
        f.principal,
        f.teamId,
        f.channelId,
        { operationKey: key(), member: { kind: 'agent', id: a.id } },
        'invite',
      );
    }
    let task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    for (let i = 0; i < 5; i++) {
      const a = members[i],
        next = members[i + 1];
      assert.ok(a);
      assert.ok(next);
      const g = await f.store.agents.issue(f.principal, f.teamId, a.id, {
        label: 'Chain',
        scopes: ['channels:read', 'tasks:read', 'tasks:write'],
        lifetimeSeconds: 3600,
      });
      task = (
        await f.act(await f.store.agents.resolveToken(g.token), task, {
          type: 'handoff',
          mode: 'work',
          recipient: { kind: 'agent', id: next.id },
          note: 'Explicit work transfer',
        })
      ).task;
    }
    assert.equal((await f.rows()).length, 5);
    assert.deepEqual(
      (await f.rows()).map((r) => r.depth),
      [0, 1, 2, 3, 4],
    );
    assert.equal(
      (await f.tasks.history(f.principal, f.teamId, f.channelId, task.id)).items
        .length,
      6,
      'suppressed delivery does not erase task audit',
    );
    await f.act(f.principal, task, {
      type: 'handoff',
      mode: 'work',
      recipient: { kind: 'agent', id: f.agent.id },
      note: 'Human recovery',
    });
    assert.equal((await f.rows()).length, 6);
    assert.equal((await f.rows()).at(-1)?.depth, 0);
    await f.comm.post(
      f.agentPrincipal,
      f.teamId,
      f.channelId,
      postInput({ mentions: [{ kind: 'agent', id: f.reviewer.id }] }),
    );
    assert.equal(
      (await f.rows()).length,
      6,
      'agent chat cannot reset causal budget',
    );
    assert.equal(
      await raw.prepare('SELECT count(*) FROM inbox_causes').pluck().get(),
      7,
    );
  } finally {
    await raw.close();
    await f.dispose();
  }
});
await test('task handoff A to B then B to A is suppressed by persisted root/target uniqueness', async () => {
  const f = await inboxFixture();
  try {
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const transferred = (
      await f.act(f.developer, task, {
        type: 'handoff',
        mode: 'work',
        recipient: { kind: 'agent', id: f.reviewer.id },
        note: 'A to B',
      })
    ).task;
    await f.act(f.reviewPrincipal, transferred, {
      type: 'handoff',
      mode: 'work',
      recipient: { kind: 'agent', id: f.agent.id },
      note: 'B to A',
    });
    assert.equal((await f.rows()).length, 2);
    assert.equal(new Set((await f.rows()).map((r) => r.rootId)).size, 1);
  } finally {
    await f.dispose();
  }
});
await test('strict private worker config rejects symlinks, public modes, duplicates and unknown fields; missing OAuth cannot become a pass', async () => {
  const f = await inboxFixture();
  try {
    assert.equal(loadWorkerConfig(f.configPath).bindings.length, 1);
    chmodSync(f.configPath, 0o644);
    assert.throws(() => loadWorkerConfig(f.configPath));
    chmodSync(f.configPath, 0o600);
    const link = join(f.directory, 'link.json');
    symlinkSync(f.configPath, link);
    assert.throws(() => loadWorkerConfig(link));
    assert.equal(
      WorkerConfig.safeParse({
        ...f.workerConfig,
        bindings: [f.binding, f.binding],
      }).success,
      false,
    );
    assert.equal(
      WorkerConfig.safeParse({ ...f.workerConfig, unsafe: true }).success,
      false,
    );
    const p = await f.store.agents.get(f.principal, f.teamId, f.agent.id);
    await assert.rejects(t3Factory(f.store)(f.binding, p, signal()));
  } finally {
    await f.dispose();
  }
});
await test('native assistant selection refuses wrong run/tool text, preserves waiting and bounds pagination/excerpts', async () => {
  const f = await inboxFixture();
  try {
    const backend = await T3Backend.connect(
      f.wire,
      f.store.operations,
      options,
    );
    const model = launch.model;
    f.wire.values.t3_thread_read = mockRead('waiting');
    assert.equal(
      (await assistantResult(backend, reference, model, signal())).kind,
      'waiting',
    );
    f.wire.values.t3_thread_read = mockRead();
    // Existing captured assistant is another run after this replacement.
    const wrong = assistantRead('Wrong run');
    wrong.items = wrong.items.map((i) => ({
      ...i,
      runId: 'other-run',
      type: 'tool_result',
    }));
    f.wire.values.t3_thread_read = wrong;
    assert.equal(
      (await assistantResult(backend, reference, model, signal())).kind,
      'waiting',
    );
    f.wire.values.t3_thread_read = assistantRead('x'.repeat(7000));
    const result = await assistantResult(backend, reference, model, signal());
    assert.equal(result.kind, 'result');
    assert.equal(result.result.text.length, 6000);
    assert.equal(result.result.truncated, true);
    const paged = assistantRead('Earlier');
    paged.hasMore = true;
    paged.nextPosition = 1;
    f.wire.handler = (name, args) =>
      Promise.resolve(
        envelope(
          name === 't3_thread_read'
            ? {
                ...paged,
                nextPosition:
                  typeof args.afterPosition === 'number'
                    ? args.afterPosition + 1
                    : 1,
              }
            : f.wire.values[name],
        ),
      );
    const before = f.wire.calls.length;
    const bounded = await assistantResult(backend, reference, model, signal());
    assert.deepEqual(bounded, {
      kind: 'waiting',
      reason: 'history-page-bound',
    });
    assert.equal(f.wire.calls.length - before, 4);
  } finally {
    await f.dispose();
  }
});
await test('a worker bound to any number of agents claims for the last of them, and binding more never throws', async () => {
  const f = await inboxFixture();
  try {
    // Forty agents, more than any former limit; only the last is mentioned.
    const ids = [f.agent.id, f.reviewer.id];
    while (ids.length < 40)
      ids.push(
        (
          await f.store.agents.create(f.principal, f.teamId, {
            ...profileInput,
            name: 'Bound ' + String(ids.length),
          })
        ).id,
      );
    const last = ids.at(-1);
    assert.ok(last);
    await f.comm.enroll(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), member: { kind: 'agent', id: last } },
      'invite',
    );
    await f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ mentions: [{ kind: 'agent', id: last }] }),
    );
    // Its liveness, then its delivery: the worker's loop does both each turn.
    await f.inbox.heartbeat(ids);
    assert.deepEqual(
      (await f.store.inboxViews.liveness(f.principal, f.teamId))
        .map((r) => r.agentId)
        .sort(),
      [...ids].sort(),
    );
    const claimed = await f.inbox.claim(ids);
    assert.equal(claimed?.agentId, last);
    // Far beyond one parameter per agent, nothing throws.
    const many = [
      ...ids,
      ...Array.from({ length: 70_000 }, () => randomUUID()),
    ].map((id) => AgentId.parse(id));
    await f.inbox.heartbeat(many);
    assert.equal(await f.inbox.claim(many), undefined);
    await f.inbox.release(many);
    assert.deepEqual(
      await f.store.inboxViews.liveness(f.principal, f.teamId),
      [],
    );
  } finally {
    await f.dispose();
  }
});
await test('claimers racing on separate connections take two deliveries, for two agents, each once', async () => {
  const f = await inboxFixture();
  const others = await Promise.all([1, 2, 3, 4, 5].map(() => f.open()));
  try {
    const third = await f.store.agents.create(f.principal, f.teamId, {
      ...profileInput,
      name: 'Racing third',
    });
    await f.comm.enroll(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), member: { kind: 'agent', id: third.id } },
      'invite',
    );
    const ids = [f.agent.id, f.reviewer.id, third.id];
    for (let i = 0; i < 2; i++)
      await f.comm.post(
        f.principal,
        f.teamId,
        f.channelId,
        postInput({ mentions: ids.map((id) => ({ kind: 'agent', id })) }),
      );
    // Every connection claims twice at once: twelve claims for two slots.
    const claimed = (
      await Promise.all(
        [f.inbox, ...others.map((s) => s.inbox)].flatMap((inbox) => [
          inbox.claim(ids),
          inbox.claim(ids),
        ]),
      )
    ).filter((c) => c !== undefined);
    assert.equal(claimed.length, INBOX_CAPACITY);
    assert.equal(new Set(claimed.map((c) => c.id)).size, INBOX_CAPACITY);
    assert.equal(new Set(claimed.map((c) => c.agentId)).size, INBOX_CAPACITY);
  } finally {
    for (const s of others) await s.close();
    await f.dispose();
  }
});
await test('global capacity two is enforced across independent connections and distinct agents', async () => {
  const f = await inboxFixture(),
    second = await f.open();
  try {
    const third = await f.store.agents.create(f.principal, f.teamId, {
      ...profileInput,
      name: 'Capacity third',
    });
    await f.comm.enroll(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), member: { kind: 'agent', id: third.id } },
      'invite',
    );
    const ids = [f.agent.id, f.reviewer.id, third.id];
    await f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ mentions: ids.map((id) => ({ kind: 'agent', id })) }),
    );
    const first = await f.inbox.claim(ids),
      next = await second.inbox.claim(ids);
    assert.ok(first);
    assert.ok(next);
    assert.notEqual(first.agentId, next.agentId);
    assert.equal(await f.inbox.claim(ids), undefined);
    assert.equal(await second.inbox.claim(ids), undefined);
    await f.inbox.defer(first, 'blocked', 'fixture-blocked');
    assert.ok(await second.inbox.claim(ids));
  } finally {
    await second.close();
    await f.dispose();
  }
});
await test('never-dispatched expiry, bounded retry history, retained facts and reserved final ACK snapshot', async () => {
  const f = await inboxFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await mention(f);
    const row = (await f.rows())[0];
    assert.ok(row);
    // Controlled clock fixture only: production code cannot edit expiry or source fields.
    await raw.exec('DROP TRIGGER inbox_source_immutable ON agent_inbox');
    await raw
      .prepare('UPDATE agent_inbox SET expires_at=1 WHERE id=?')
      .run(row.id);
    assert.equal(await f.inbox.claim([f.agent.id]), undefined);
    assert.equal((await f.inbox.get(row.id)).state, 'expired');
    await mention(f);
    for (let n = 0; n < 140; n++) {
      const c = await claim(f);
      await f.inbox.defer(c, 'ready', 'fixture-retry');
      await due(f.dbPath);
    }
    const c = await claim(f);
    await freeze(f, c);
    const count = () =>
      raw
        .prepare('SELECT count(*) FROM inbox_history WHERE delivery_id=?')
        .pluck()
        .get(c.id);
    assert.equal(await count(), 127);
    await f.inbox.ack(c, f.workerPrincipal, fixtureResult());
    assert.equal(await count(), 128);
    assert.equal((await f.inbox.get(c.id)).attempts, 141);
    assert.equal(
      (await f.comm.history(f.principal, f.teamId, f.channelId)).items.length,
      3,
    );
    assert.equal(
      (await f.rows()).length,
      2,
      'expiry retains historical delivery and source',
    );
  } finally {
    await raw.close();
    await f.dispose();
  }
});
await test('frozen T3 endpoint/authority and Kinmesh grant cannot switch after uncertain dispatch', async () => {
  for (const change of ['endpoint', 'authority', 'grant'] as const) {
    const f = await inboxFixture();
    try {
      await mention(f);
      const c = await claim(f);
      f.wire.handler = (name) =>
        name === 't3_thread_launch'
          ? Promise.reject(new Error('Fixture disconnect'))
          : Promise.resolve(envelope(f.wire.values[name]));
      await deliver(f.store, c, f.binding, f.factory, signal());
      await due(f.dbPath);
      const next = await claim(f);
      f.wire.handler = undefined;
      const identity = {
        endpoint: options.endpoint,
        environmentId: reference.environmentId,
        authority: options.authority,
      };
      const binding = { ...f.binding };
      if (change === 'endpoint') {
        identity.endpoint = 'https://other.invalid/mcp';
        binding.t3Endpoint = identity.endpoint;
      }
      if (change === 'authority')
        identity.authority = 'different-approved-principal';
      if (change === 'grant') {
        const rotated = await f.store.agents.issue(
          f.principal,
          f.teamId,
          f.agent.id,
          {
            label: 'New worker grant',
            scopes: [
              'channels:read',
              'channels:write',
              'tasks:read',
              'tasks:write',
              'executions:write',
            ],
            lifetimeSeconds: 3600,
          },
        );
        writeFileSync(
          binding.tokenFile,
          JSON.stringify({ token: rotated.token }),
          { mode: 0o600 },
        );
      }
      const backend = await T3Backend.connect(
        f.wire,
        f.store.operations,
        options,
      );
      await deliver(
        f.store,
        next,
        binding,
        () =>
          Promise.resolve({ backend, identity, close: () => f.wire.close() }),
        signal(),
      );
      assert.equal((await f.inbox.get(c.id)).state, 'blocked');
      assert.equal(
        f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
        1,
      );
    } finally {
      await f.dispose();
    }
  }
});
await test('MOCK native waiting/pending approval remains waiting across retries without another launch or task acceptance', async () => {
  const f = await inboxFixture();
  try {
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    // A pending approval belongs to this nonterminal Run, not a completed Run.
    const base = assistantRead('Fixture pending approval', 'waiting');
    const pending = {
      ...base,
      thread: { ...base.thread, pendingRequestCount: 1 },
    };
    f.wire.values.t3_thread_read = pending;
    const first = await claim(f);
    await deliver(f.store, first, f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(first.id)).state, 'waiting');
    assert.equal((await f.inbox.get(first.id)).resultMessageId, null);
    await due(f.dbPath);
    await deliver(f.store, await claim(f), f.binding, f.factory, signal());
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
    assert.equal(
      (await f.tasks.get(f.principal, f.teamId, f.channelId, task.id)).state
        .status,
      'in-progress',
    );
    f.wire.values.t3_thread_read = assistantRead('Actual fixture result');
    await due(f.dbPath);
    await deliver(f.store, await claim(f), f.binding, f.factory, signal());
    assert.equal((await f.inbox.get(first.id)).state, 'acked');
  } finally {
    await f.dispose();
  }
});
await test('lease lost inside publication rolls back downstream message/outbox/link and ACK together', async () => {
  const f = await inboxFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await f.create({ owner: { kind: 'agent', id: f.agent.id } });
    const c = await claim(f);
    await freeze(f, c);
    const counts = () =>
      Promise.all(
        [
          'messages',
          'communication_outbox',
          'task_events',
          'task_executions',
          'agent_correlations',
          'inbox_results',
        ].map((t) =>
          raw
            .prepare('SELECT count(*) FROM ' + t)
            .pluck()
            .get(),
        ),
      );
    const before = await counts();
    await raw.trigger(
      'fixture_lose_fence',
      'inbox_results',
      'UPDATE agent_inbox SET lease_until = 1 WHERE id = NEW.delivery_id;',
    );
    await assert.rejects(
      async () => f.inbox.ack(c, f.workerPrincipal, fixtureResult()),
      IdentityError,
    );
    assert.deepEqual(await counts(), before);
    assert.equal((await f.inbox.get(c.id)).leaseUntil, c.leaseUntil);
    assert.equal((await f.inbox.get(c.id)).state, 'ready');
  } finally {
    await raw.close();
    await f.dispose();
  }
});
await test('MOCK external adapter: explicit task handoff wakes authorized recipient once and publishes actual source-linked result', async () => {
  const f = await inboxFixture();
  try {
    const profile = await f.store.agents.get(f.principal, f.teamId, f.agent.id);
    await f.store.agents.update(f.principal, f.teamId, f.reviewer.id, {
      ...profileInput,
      name: 'Reviewer',
      role: 'reviewer',
      preferences: profile.preferences,
    });
    const grant = await f.store.agents.issue(
      f.principal,
      f.teamId,
      f.reviewer.id,
      {
        label: 'Inbox recipient',
        scopes: [
          'channels:read',
          'channels:write',
          'tasks:read',
          'tasks:write',
          'executions:write',
        ],
        lifetimeSeconds: 3600,
      },
    );
    const tokenFile = join(f.directory, 'review-worker.json');
    writeFileSync(tokenFile, JSON.stringify({ token: grant.token }), {
      mode: 0o600,
    });
    const task = (await f.create({ owner: { kind: 'agent', id: f.agent.id } }))
      .task;
    const handoff = await f.act(f.developer, task, {
      type: 'handoff',
      mode: 'work',
      recipient: { kind: 'agent', id: f.reviewer.id },
      note: 'Explicit delegated responsibility',
    });
    const c = await f.inbox.claim([f.reviewer.id]);
    assert.ok(c);
    assert.equal(c.eventId, handoff.eventId);
    assert.equal(c.depth, 1);
    await deliver(
      f.store,
      c,
      { ...f.binding, agentId: f.reviewer.id, tokenFile },
      f.factory,
      signal(),
    );
    const row = await f.inbox.get(c.id);
    assert.equal(row.state, 'acked');
    assert.ok(row.resultMessageId);
    const message = await f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      row.resultMessageId,
    );
    assert.equal(message.author.kind, 'agent');
    assert.equal(message.author.agentId, f.reviewer.id);
    assert.equal(message.sourceEventId, handoff.eventId);
    assert.equal(await f.inbox.claim([f.reviewer.id]), undefined);
    assert.equal(
      (await f.tasks.get(f.principal, f.teamId, f.channelId, task.id)).state
        .status,
      'in-progress',
    );
  } finally {
    await f.dispose();
  }
});
