import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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
const mention = (
  f: Awaited<ReturnType<typeof inboxFixture>>,
  body = 'Human asks for a response',
) =>
  f.comm.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({ body, mentions: [{ kind: 'agent', id: f.agent.id }] }),
  );
function claim(f: Awaited<ReturnType<typeof inboxFixture>>) {
  const c = f.inbox.claim([f.agent.id]);
  assert.ok(c);
  return c;
}
function freeze(f: Awaited<ReturnType<typeof inboxFixture>>, c: Claim) {
  assert.equal(f.workerPrincipal.kind, 'agent');
  const p = f.workerPrincipal;
  assert.equal(p.kind, 'agent');
  f.inbox.freeze(
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
  f.inbox.remember(c, reference);
}
await test('inbox enqueue and outbox/receipt are atomic; exact replay is once and collision fails', async () => {
  const f = await inboxFixture();
  const raw = new Database(f.dbPath);
  try {
    const input = postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] });
    const message = f.comm.post(f.principal, f.teamId, f.channelId, input);
    assert.equal(
      f.comm.post(f.principal, f.teamId, f.channelId, input).id,
      message.id,
    );
    assert.equal(f.rows().length, 1);
    assert.throws(
      () =>
        f.comm.post(f.principal, f.teamId, f.channelId, {
          ...input,
          body: 'Different',
        }),
      IdentityError,
    );
    const counts = () =>
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
      );
    const before = counts();
    raw.exec(
      "CREATE TRIGGER reject_inbox BEFORE INSERT ON agent_inbox BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    assert.throws(() => mention(f));
    assert.deepEqual(counts(), before);
    assert.throws(() => f.create({ owner: { kind: 'agent', id: f.agent.id } }));
    assert.deepEqual(counts(), before);
  } finally {
    raw.close();
    await f.dispose();
  }
});
await test('MOCK external adapter: exact-run actual assistant is attributed and ACK/message/outbox/task/correlation commit together without acceptance', async () => {
  const f = await inboxFixture();
  try {
    const source = mention(f);
    const c = claim(f);
    await deliver(f.store, c, f.binding, f.factory, signal());
    const row = f.inbox.get(c.id);
    assert.equal(row.state, 'acked');
    assert.ok(row.resultMessageId);
    const message = f.comm.message(
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
    assert.ok(message.body.includes('run ' + (reference.runId ?? '')));
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
    assert.equal(
      f.rows().length,
      1,
      'result has no mentions, cannot wake itself',
    );
    assert.equal(f.inbox.claim([f.agent.id]), undefined);
    const reopened = f.open();
    try {
      assert.equal(reopened.inbox.get(c.id).resultMessageId, message.id);
      assert.equal(
        reopened.agents.correlations(f.principal, f.teamId, f.agent.id).length,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await f.dispose();
  }
});
await test('MOCK native terminal failure without assistant posts truthful notice and releases the same-agent queue', async () => {
  const f = await inboxFixture();
  try {
    const source = mention(f);
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
    const c = claim(f);
    await deliver(f.store, c, f.binding, f.factory, signal());
    const row = f.inbox.get(c.id);
    assert.equal(row.state, 'acked');
    assert.equal(row.reason, 'native-terminal-notice-published');
    assert.ok(row.resultMessageId);
    const notice = f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      row.resultMessageId,
    );
    assert.ok(notice.body.includes('T3 failed; native status notice only'));
    assert.ok(notice.body.includes('no assistant message observed'));
    assert.ok(!notice.body.includes('item '));
    assert.ok(!notice.body.includes('Fixture assistant output'));
    assert.equal(notice.sourceMessageId, source.id);
    assert.equal(notice.sourceEventId, c.eventId);
    assert.equal(notice.author.kind, 'agent');
    assert.equal(notice.author.agentId, f.agent.id);
    const reopened = f.open();
    try {
      assert.equal(reopened.inbox.get(c.id).state, 'acked');
      assert.equal(
        reopened.agents.correlations(f.principal, f.teamId, f.agent.id).length,
        1,
      );
    } finally {
      reopened.close();
    }
    mention(f, 'Second independently authorized human request');
    const following = claim(f);
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
    const actual = await assistantResult(backend, reference, launch.model, signal());
    if (actual.kind !== 'result')
      throw new Error('Expected the exact completed Run assistant result');
    assert.equal(actual.result.reference.runId, reference.runId);
    assert.equal(actual.result.text, 'fixture-redacted');
  } finally {
    await f.dispose();
  }
});
for (const failedTable of [
  'communication_outbox',
  'inbox_results',
  'inbox_history',
])
  await test(
    'ACK rollback at ' +
      failedTable +
      ' leaves no partial result/link/audit/receipt',
    async () => {
      const f = await inboxFixture();
      const raw = new Database(f.dbPath);
      try {
        const task = f.create({
          owner: { kind: 'agent', id: f.agent.id },
        }).task;
        const c = claim(f);
        freeze(f, c);
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
          tables.map((t) =>
            raw
              .prepare('SELECT count(*) FROM ' + t)
              .pluck()
              .get(),
          );
        const before = counts();
        const condition =
          failedTable === 'inbox_history'
            ? " WHEN NEW.reason='assistant-result-published'"
            : '';
        raw.exec(
          'CREATE TRIGGER reject_ack BEFORE INSERT ON ' +
            failedTable +
            condition +
            " BEGIN SELECT RAISE(ABORT,'fixture'); END",
        );
        assert.throws(() => f.inbox.ack(c, f.workerPrincipal, fixtureResult()));
        assert.deepEqual(counts(), before);
        assert.equal(f.inbox.get(c.id).state, 'ready');
        assert.equal(
          f.tasks.get(f.principal, f.teamId, f.channelId, task.id).version,
          1,
        );
        raw.exec('DROP TRIGGER reject_ack');
        const result = f.inbox.ack(c, f.workerPrincipal, fixtureResult());
        assert.equal(f.inbox.get(c.id).resultMessageId, result.id);
        const current = f.tasks.get(
          f.principal,
          f.teamId,
          f.channelId,
          task.id,
        );
        assert.equal(current.state.status, 'in-progress');
        assert.equal(current.version, 2);
        assert.equal(
          f.tasks.executions(f.principal, f.teamId, f.channelId, task.id).items
            .length,
          1,
        );
        assert.throws(
          () => f.inbox.ack(c, f.workerPrincipal, fixtureResult()),
          IdentityError,
        );
        assert.equal(
          raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
          1,
        );
      } finally {
        raw.close();
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
    const raw = new Database(f.dbPath);
    try {
      if (denied === 'reassigned')
        f.create({ owner: { kind: 'agent', id: f.agent.id } });
      else mention(f);
      const c = claim(f);
      if (denied === 'disabled')
        f.store.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'disabled');
      if (denied === 'revoked')
        f.store.agents.revoke(
          f.principal,
          f.teamId,
          f.agent.id,
          f.inboxGrant.grant.id,
        );
      if (denied === 'removed')
        f.comm.enroll(
          f.principal,
          f.teamId,
          f.channelId,
          { operationKey: key(), member: { kind: 'agent', id: f.agent.id } },
          'remove',
        );
      if (denied === 'scope') {
        const g = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
          label: 'Insufficient',
          scopes: ['channels:read'],
          lifetimeSeconds: 3600,
        });
        writeFileSync(f.binding.tokenFile, JSON.stringify({ token: g.token }), {
          mode: 0o600,
        });
      }
      if (denied === 'cross-team') {
        assert.throws(
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
        assert.throws(
          () => f.inbox.context(c, f.reviewPrincipal),
          IdentityError,
        );
        return;
      }
      if (denied === 'reassigned') {
        assert.ok(c.taskId);
        const task = f.tasks.get(f.principal, f.teamId, f.channelId, c.taskId);
        f.act(f.principal, task, {
          type: 'handoff',
          mode: 'work',
          recipient: { kind: 'agent', id: f.reviewer.id },
          note: 'Human transfer',
        });
      }
      await deliver(f.store, c, f.binding, f.factory, signal());
      assert.equal(f.inbox.get(c.id).state, 'blocked');
      assert.equal(f.wire.calls.length, 0);
      assert.equal(
        raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
        0,
      );
    } finally {
      raw.close();
      await f.dispose();
    }
  });
await test('revocation after launch prevents publication and retains native reference for operator reconciliation', async () => {
  const f = await inboxFixture();
  try {
    mention(f);
    const c = claim(f);
    f.wire.handler = (name) => {
      if (name === 't3_thread_read')
        f.store.agents.revoke(
          f.principal,
          f.teamId,
          f.agent.id,
          f.inboxGrant.grant.id,
        );
      return Promise.resolve(envelope(f.wire.values[name]));
    };
    await deliver(f.store, c, f.binding, f.factory, signal());
    assert.equal(f.inbox.get(c.id).state, 'blocked');
    assert.notEqual(f.inbox.get(c.id).reference, null);
    assert.equal(f.inbox.get(c.id).resultMessageId, null);
  } finally {
    await f.dispose();
  }
});
await test('context is bounded, source-attributed, preserves topic/task/memory reference and is frozen once', async () => {
  const f = await inboxFixture();
  try {
    const topic = f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'A topic',
    });
    const task = f.create({
      topicId: topic.id,
      owner: { kind: 'agent', id: f.agent.id },
      description: 'd'.repeat(4000),
      criteria: Array.from(
        { length: 20 },
        (_, i) => String(i) + 'c'.repeat(400),
      ),
    }).task;
    const c = claim(f);
    const { context } = f.inbox.context(c, f.workerPrincipal);
    assert.equal(context.task?.id, task.id);
    assert.equal(context.topic?.id, topic.id);
    assert.equal(context.author.kind, 'human');
    assert.equal(context.memoryLocation, profileInput.memoryLocation);
    assert.equal(context.task.truncated, true);
    assert.ok(JSON.stringify(context).length < 10000);
    freeze(f, c);
    const old = f.inbox.get(c.id).launch;
    const p = f.workerPrincipal;
    assert.equal(p.kind, 'agent');
    const same = f.inbox.freeze(c, p, {
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
    mention(f);
    const c = claim(f);
    f.wire.handler = (name) =>
      name === 't3_thread_launch'
        ? Promise.reject(new Error('Fixture lost reply'))
        : Promise.resolve(envelope(f.wire.values[name]));
    await deliver(f.store, c, f.binding, f.factory, signal());
    assert.equal(f.inbox.get(c.id).state, 'uncertain');
    assert.ok(f.inbox.get(c.id).operationId);
    const first = f.wire.calls.find((c) => c.name === 't3_thread_launch')?.args
      .clientRequestId;
    due(f.dbPath);
    f.wire.handler = undefined;
    const reopened = f.open();
    try {
      const backend = await T3Backend.connect(
        f.wire,
        reopened.operations,
        options,
      );
      const recovered = reopened.inbox.claim([f.agent.id]);
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
      assert.equal(reopened.inbox.get(c.id).state, 'acked');
      const calls = f.wire.calls.filter((c) => c.name === 't3_thread_launch');
      assert.equal(calls.length, 2);
      assert.ok(calls.every((c) => c.args.clientRequestId === first));
    } finally {
      reopened.close();
    }
  } finally {
    await f.dispose();
  }
});
await test('native connection unavailable keeps retryable work with bounded backoff and no retry exhaustion', async () => {
  const f = await inboxFixture();
  try {
    mention(f);
    for (let i = 0; i < 12; i++) {
      const c = claim(f);
      await deliver(
        f.store,
        c,
        f.binding,
        () => Promise.reject(new Error('External unavailable')),
        signal(),
      );
      const row = f.inbox.get(c.id);
      assert.equal(row.state, 'ready');
      assert.ok(row.nextAttempt > Date.now() - 100);
      assert.equal(row.resultMessageId, null);
      due(f.dbPath);
    }
    assert.equal(f.rows()[0]?.attempts, 12);
    assert.equal(retryDelay(100000), 300000);
    assert.equal(f.wire.calls.length, 0);
  } finally {
    await f.dispose();
  }
});
await test('leases fence every stale write and ACK; global capacity and per-agent order hold across connections', async () => {
  const f = await inboxFixture();
  const other = f.open();
  const raw = new Database(f.dbPath);
  try {
    mention(f);
    mention(f);
    const c = claim(f);
    freeze(f, c);
    assert.equal(other.inbox.claim([f.agent.id]), undefined);
    due(f.dbPath, true);
    assert.throws(() => {
      f.inbox.remember(c, reference);
    }, IdentityError);
    assert.throws(() => {
      f.inbox.defer(c, 'ready', 'stale');
    }, IdentityError);
    assert.throws(
      () => f.inbox.ack(c, f.workerPrincipal, fixtureResult()),
      IdentityError,
    );
    const next = other.inbox.claim([f.agent.id]);
    assert.ok(next);
    assert.equal(next.id, c.id);
    assert.equal(next.generation, c.generation + 1);
    assert.throws(
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
    other.inbox.ack(next, f.workerPrincipal, fixtureResult());
    assert.ok(f.inbox.claim([f.agent.id]));
    assert.equal(INBOX_CAPACITY, 2);
    assert.throws(() => raw.exec('DELETE FROM inbox_history'));
    assert.throws(() =>
      raw.exec("UPDATE agent_inbox SET event_id='rewritten'"),
    );
    assert.throws(() => raw.exec('DELETE FROM agent_inbox'));
  } finally {
    raw.close();
    other.close();
    await f.dispose();
  }
});
await test('agent handoffs follow trusted audit chain, one target per chain, finite budget; human intervention resets it', async () => {
  const f = await inboxFixture();
  const raw = new Database(f.dbPath);
  try {
    const members = [f.agent];
    for (let i = 1; i < 6; i++) {
      const a = f.store.agents.create(f.principal, f.teamId, {
        ...profileInput,
        name: 'Chain ' + String(i),
      });
      members.push(a);
      f.comm.enroll(
        f.principal,
        f.teamId,
        f.channelId,
        { operationKey: key(), member: { kind: 'agent', id: a.id } },
        'invite',
      );
    }
    let task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
    for (let i = 0; i < 5; i++) {
      const a = members[i],
        next = members[i + 1];
      assert.ok(a);
      assert.ok(next);
      const g = f.store.agents.issue(f.principal, f.teamId, a.id, {
        label: 'Chain',
        scopes: ['channels:read', 'tasks:read', 'tasks:write'],
        lifetimeSeconds: 3600,
      });
      task = f.act(f.store.agents.resolveToken(g.token), task, {
        type: 'handoff',
        mode: 'work',
        recipient: { kind: 'agent', id: next.id },
        note: 'Explicit work transfer',
      }).task;
    }
    assert.equal(f.rows().length, 5);
    assert.deepEqual(
      f.rows().map((r) => r.depth),
      [0, 1, 2, 3, 4],
    );
    assert.equal(
      f.tasks.history(f.principal, f.teamId, f.channelId, task.id).items.length,
      6,
      'suppressed delivery does not erase task audit',
    );
    f.act(f.principal, task, {
      type: 'handoff',
      mode: 'work',
      recipient: { kind: 'agent', id: f.agent.id },
      note: 'Human recovery',
    });
    assert.equal(f.rows().length, 6);
    assert.equal(f.rows().at(-1)?.depth, 0);
    f.comm.post(
      f.agentPrincipal,
      f.teamId,
      f.channelId,
      postInput({ mentions: [{ kind: 'agent', id: f.reviewer.id }] }),
    );
    assert.equal(f.rows().length, 6, 'agent chat cannot reset causal budget');
    assert.equal(
      raw.prepare('SELECT count(*) FROM inbox_causes').pluck().get(),
      7,
    );
  } finally {
    raw.close();
    await f.dispose();
  }
});
await test('task handoff A to B then B to A is suppressed by persisted root/target uniqueness', async () => {
  const f = await inboxFixture();
  try {
    const task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
    const transferred = f.act(f.developer, task, {
      type: 'handoff',
      mode: 'work',
      recipient: { kind: 'agent', id: f.reviewer.id },
      note: 'A to B',
    }).task;
    f.act(f.reviewPrincipal, transferred, {
      type: 'handoff',
      mode: 'work',
      recipient: { kind: 'agent', id: f.agent.id },
      note: 'B to A',
    });
    assert.equal(f.rows().length, 2);
    assert.equal(new Set(f.rows().map((r) => r.rootId)).size, 1);
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
    const p = f.store.agents.get(f.principal, f.teamId, f.agent.id);
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
await test('global capacity two is enforced across independent SQLite connections and distinct agents', async () => {
  const f = await inboxFixture(),
    second = f.open();
  try {
    const third = f.store.agents.create(f.principal, f.teamId, {
      ...profileInput,
      name: 'Capacity third',
    });
    f.comm.enroll(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), member: { kind: 'agent', id: third.id } },
      'invite',
    );
    const ids = [f.agent.id, f.reviewer.id, third.id];
    f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ mentions: ids.map((id) => ({ kind: 'agent', id })) }),
    );
    const first = f.inbox.claim(ids),
      next = second.inbox.claim(ids);
    assert.ok(first);
    assert.ok(next);
    assert.notEqual(first.agentId, next.agentId);
    assert.equal(f.inbox.claim(ids), undefined);
    assert.equal(second.inbox.claim(ids), undefined);
    f.inbox.defer(first, 'blocked', 'fixture-blocked');
    assert.ok(second.inbox.claim(ids));
  } finally {
    second.close();
    await f.dispose();
  }
});
await test('never-dispatched expiry, bounded retry history, retained facts and reserved final ACK snapshot', async () => {
  const f = await inboxFixture();
  const raw = new Database(f.dbPath);
  try {
    mention(f);
    const row = f.rows()[0];
    assert.ok(row);
    // Controlled clock fixture only: production code cannot edit expiry or source fields.
    raw.exec('DROP TRIGGER inbox_source_immutable');
    raw.prepare('UPDATE agent_inbox SET expires_at=1 WHERE id=?').run(row.id);
    assert.equal(f.inbox.claim([f.agent.id]), undefined);
    assert.equal(f.inbox.get(row.id).state, 'expired');
    mention(f);
    for (let n = 0; n < 140; n++) {
      const c = claim(f);
      f.inbox.defer(c, 'ready', 'fixture-retry');
      due(f.dbPath);
    }
    const c = claim(f);
    freeze(f, c);
    const count = () =>
      raw
        .prepare('SELECT count(*) FROM inbox_history WHERE delivery_id=?')
        .pluck()
        .get(c.id);
    assert.equal(count(), 127);
    f.inbox.ack(c, f.workerPrincipal, fixtureResult());
    assert.equal(count(), 128);
    assert.equal(f.inbox.get(c.id).attempts, 141);
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      3,
    );
    assert.equal(
      f.rows().length,
      2,
      'expiry retains historical delivery and source',
    );
  } finally {
    raw.close();
    await f.dispose();
  }
});
await test('frozen T3 endpoint/authority and Kinmesh grant cannot switch after uncertain dispatch', async () => {
  for (const change of ['endpoint', 'authority', 'grant'] as const) {
    const f = await inboxFixture();
    try {
      mention(f);
      const c = claim(f);
      f.wire.handler = (name) =>
        name === 't3_thread_launch'
          ? Promise.reject(new Error('Fixture disconnect'))
          : Promise.resolve(envelope(f.wire.values[name]));
      await deliver(f.store, c, f.binding, f.factory, signal());
      due(f.dbPath);
      const next = claim(f);
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
        const rotated = f.store.agents.issue(
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
      assert.equal(f.inbox.get(c.id).state, 'blocked');
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
    const task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
    const base = assistantRead('Fixture pending approval');
    const pending = {
      ...base,
      thread: { ...base.thread, pendingRequestCount: 1 },
    };
    f.wire.values.t3_thread_read = pending;
    const first = claim(f);
    await deliver(f.store, first, f.binding, f.factory, signal());
    assert.equal(f.inbox.get(first.id).state, 'waiting');
    assert.equal(f.inbox.get(first.id).resultMessageId, null);
    due(f.dbPath);
    await deliver(f.store, claim(f), f.binding, f.factory, signal());
    assert.equal(
      f.wire.calls.filter((c) => c.name === 't3_thread_launch').length,
      1,
    );
    assert.equal(
      f.tasks.get(f.principal, f.teamId, f.channelId, task.id).state.status,
      'in-progress',
    );
    f.wire.values.t3_thread_read = assistantRead('Actual fixture result');
    due(f.dbPath);
    await deliver(f.store, claim(f), f.binding, f.factory, signal());
    assert.equal(f.inbox.get(first.id).state, 'acked');
  } finally {
    await f.dispose();
  }
});
await test('lease lost inside publication rolls back downstream message/outbox/link and ACK together', async () => {
  const f = await inboxFixture();
  const raw = new Database(f.dbPath);
  try {
    f.create({ owner: { kind: 'agent', id: f.agent.id } });
    const c = claim(f);
    freeze(f, c);
    const counts = () =>
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
      );
    const before = counts();
    raw.exec(
      'CREATE TRIGGER fixture_lose_fence BEFORE INSERT ON inbox_results BEGIN UPDATE agent_inbox SET lease_until=1 WHERE id=NEW.delivery_id; END',
    );
    assert.throws(
      () => f.inbox.ack(c, f.workerPrincipal, fixtureResult()),
      IdentityError,
    );
    assert.deepEqual(counts(), before);
    assert.equal(f.inbox.get(c.id).leaseUntil, c.leaseUntil);
    assert.equal(f.inbox.get(c.id).state, 'ready');
  } finally {
    raw.close();
    await f.dispose();
  }
});
await test('MOCK external adapter: explicit task handoff wakes authorized recipient once and publishes actual source-linked result', async () => {
  const f = await inboxFixture();
  try {
    const profile = f.store.agents.get(f.principal, f.teamId, f.agent.id);
    f.store.agents.update(f.principal, f.teamId, f.reviewer.id, {
      ...profileInput,
      name: 'Reviewer',
      role: 'reviewer',
      preferences: profile.preferences,
    });
    const grant = f.store.agents.issue(f.principal, f.teamId, f.reviewer.id, {
      label: 'Inbox recipient',
      scopes: [
        'channels:read',
        'channels:write',
        'tasks:read',
        'tasks:write',
        'executions:write',
      ],
      lifetimeSeconds: 3600,
    });
    const tokenFile = join(f.directory, 'review-worker.json');
    writeFileSync(tokenFile, JSON.stringify({ token: grant.token }), {
      mode: 0o600,
    });
    const task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
    const handoff = f.act(f.developer, task, {
      type: 'handoff',
      mode: 'work',
      recipient: { kind: 'agent', id: f.reviewer.id },
      note: 'Explicit delegated responsibility',
    });
    const c = f.inbox.claim([f.reviewer.id]);
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
    const row = f.inbox.get(c.id);
    assert.equal(row.state, 'acked');
    assert.ok(row.resultMessageId);
    const message = f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      row.resultMessageId,
    );
    assert.equal(message.author.kind, 'agent');
    assert.equal(message.author.agentId, f.reviewer.id);
    assert.equal(message.sourceEventId, handoff.eventId);
    assert.equal(f.inbox.claim([f.reviewer.id]), undefined);
    assert.equal(
      f.tasks.get(f.principal, f.teamId, f.channelId, task.id).state.status,
      'in-progress',
    );
  } finally {
    await f.dispose();
  }
});
