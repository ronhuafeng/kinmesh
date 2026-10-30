import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { HumanId } from '../src/domain/contracts.js';
import { IdentityError } from '../src/domain/agents.js';
import { pageOf, TaskFact } from '../src/domain/communication.js';
import {
  Task,
  TaskCommand,
  TaskResult,
  TaskEvent,
  TaskExecution,
  transition,
  principalMember,
} from '../src/domain/tasks.js';
import { createApp } from '../src/server/app.js';
import { key, postInput } from './communication-helpers.js';
import { taskFixture, taskInput, commandInput } from './task-helpers.js';
const rejected = (status: number) => (e: unknown) =>
  e instanceof IdentityError && e.statusCode === status;

await test('task domain algebra rejects invalid commands/transitions and never lets an agent final-accept', async () => {
  const f = await taskFixture();
  try {
    const task = f.create().task;
    assert.throws(
      () =>
        transition(
          task,
          f.developer,
          commandInput(task, { type: 'progress', note: 'No owner' }),
          false,
          new Date().toISOString(),
        ),
      rejected(403),
    );
    assert.throws(
      () =>
        transition(
          task,
          f.principal,
          commandInput(task, { type: 'accept', note: 'Premature' }),
          true,
          new Date().toISOString(),
        ),
      rejected(409),
    );
    assert.equal(
      TaskCommand.safeParse({ type: 'claim', operationKey: key() }).success,
      false,
    );
    assert.equal(
      TaskCommand.safeParse({
        type: 'accept',
        operationKey: key(),
        expectedVersion: 1,
        note: 'No',
        actorId: f.owner.id,
      }).success,
      false,
    );
    const claimed = f.act(f.developer, task, { type: 'claim' }).task;
    assert.throws(
      () =>
        transition(
          claimed,
          f.developer,
          commandInput(claimed, { type: 'accept', note: 'I declare success' }),
          true,
          new Date().toISOString(),
        ),
      rejected(403),
    );
    assert.throws(
      () =>
        transition(
          claimed,
          f.developer,
          commandInput(claimed, {
            type: 'request-review',
            reviewer: principalMember(f.developer),
            note: 'Self review',
          }),
          false,
          new Date().toISOString(),
        ),
      rejected(409),
    );
    const invalid = Task.safeParse({
      ...task,
      state: { status: 'in-progress', owner: null, reviewer: null, note: null },
    });
    assert.equal(invalid.success, false);
  } finally {
    await f.dispose();
  }
});

await test('real task HTTP responsibility journey: human creation, developer claim/progress/reviewer handoff, technical approval and verified human acceptance', async () => {
  const f = await taskFixture();
  try {
    const topic = f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'Task context',
    });
    const create = await f.app.inject({
      method: 'POST',
      url: f.taskPath,
      cookies: f.cookies,
      payload: taskInput({ topicId: topic.id }),
    });
    assert.equal(create.statusCode, 201);
    let task = TaskResult.parse(create.json<unknown>()).task;
    async function send(
      headers: Record<string, string> | null,
      input: z.infer<typeof TaskCommand>,
    ) {
      const { type, ...payload } = input;
      const response = await f.app.inject({
        method: 'POST',
        url: f.taskPath + '/' + task.id + '/' + type,
        ...(headers === null ? { cookies: f.cookies } : { headers }),
        payload,
      });
      assert.equal(response.statusCode, 200);
      return TaskResult.parse(response.json<unknown>());
    }
    task = (
      await send(f.developerHeaders, commandInput(task, { type: 'claim' }))
    ).task;
    assert.deepEqual(task.state.owner, principalMember(f.developer));
    task = (
      await send(
        f.developerHeaders,
        commandInput(task, {
          type: 'progress',
          note: 'Implementation checked',
        }),
      )
    ).task;
    task = (
      await send(
        f.developerHeaders,
        commandInput(task, {
          type: 'handoff',
          recipient: { kind: 'agent', id: f.reviewer.id },
          mode: 'review',
          note: 'Independent review',
        }),
      )
    ).task;
    assert.equal(task.state.status, 'review-requested');
    assert.deepEqual(task.state.owner, principalMember(f.developer));
    task = (
      await send(
        f.reviewerHeaders,
        commandInput(task, {
          type: 'review',
          decision: 'approve',
          note: 'Technical checks passed',
        }),
      )
    ).task;
    assert.equal(task.state.status, 'awaiting-human');
    const agentAccept = await f.app.inject({
      method: 'POST',
      url: f.taskPath + '/' + task.id + '/accept',
      headers: f.developerHeaders,
      payload: {
        operationKey: key(),
        expectedVersion: task.version,
        note: 'Agent cannot accept',
      },
    });
    assert.equal(agentAccept.statusCode, 403);
    task = (
      await send(
        null,
        commandInput(task, {
          type: 'accept',
          note: 'Human owner accepts criteria',
        }),
      )
    ).task;
    assert.equal(task.state.status, 'accepted');
    assert.equal(task.state.acceptedBy, f.owner.id);
    const history = await f.app.inject({
      url: f.taskPath + '/' + task.id + '/history',
      headers: f.developerHeaders,
    });
    assert.equal(history.statusCode, 200);
    const events = pageOf(TaskEvent).parse(history.json<unknown>()).items;
    assert.deepEqual(
      events.map((e) => e.action),
      ['create', 'claim', 'progress', 'handoff', 'review', 'accept'],
    );
    assert.equal(events.at(-1)?.author.kind, 'human');
    assert.equal(events[4]?.author.kind, 'agent');
    assert.equal(events[3]?.before?.state.owner?.id, f.agent.id);
    assert.equal(events[3].after.state.owner?.id, f.agent.id);
    const facts = f.comm
      .events(f.principal, f.teamId, f.channelId)
      .items.filter((e) => e.fact.kind === 'task.changed');
    assert.equal(facts.length, 6);
    assert.equal(facts.at(-1)?.fact.sourceEventId, facts.at(-2)?.fact.id);
    assert.throws(
      () =>
        f.act(f.developer, task, {
          type: 'progress',
          note: 'After acceptance',
        }),
      rejected(409),
    );
  } finally {
    await f.dispose();
  }
});

await test('reviewer rework, owner resubmission, human rework/cancel and explicit work handoff preserve responsibility/history', async () => {
  const f = await taskFixture();
  try {
    let task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
    task = f.act(f.developer, task, {
      type: 'request-review',
      reviewer: { kind: 'agent', id: f.reviewer.id },
      note: 'Review',
    }).task;
    task = f.act(f.reviewPrincipal, task, {
      type: 'review',
      decision: 'rework',
      note: 'Needs fixes',
    }).task;
    assert.equal(task.state.status, 'rework-requested');
    task = f.act(f.developer, task, { type: 'progress', note: 'Fixed' }).task;
    task = f.act(f.principal, task, {
      type: 'rework',
      note: 'Human requests clarification',
    }).task;
    assert.equal(task.state.status, 'rework-requested');
    task = f.act(f.developer, task, {
      type: 'handoff',
      recipient: { kind: 'agent', id: f.reviewer.id },
      mode: 'work',
      note: 'Transfer work ownership',
    }).task;
    assert.equal(task.state.owner?.id, f.reviewer.id);
    assert.equal(task.state.reviewer, null);
    assert.throws(
      () => f.act(f.developer, task, { type: 'progress', note: 'Old owner' }),
      rejected(403),
    );
    task = f.act(f.principal, task, {
      type: 'cancel',
      note: 'Human cancels scope',
    }).task;
    assert.equal(task.state.status, 'cancelled');
    assert.throws(
      () => f.act(f.reviewPrincipal, task, { type: 'claim' }),
      rejected(409),
    );
    const unclaimed = f.create().task;
    assert.equal(
      f.act(f.principal, unclaimed, {
        type: 'cancel',
        note: 'Cancel unclaimed',
      }).task.state.status,
      'cancelled',
    );
  } finally {
    await f.dispose();
  }
});

await test('two different authenticated agent processes race one proposed task; SQL guarded claim has exactly one winner and one audit/fact', async () => {
  const f = await taskFixture();
  const task = f.create().task;
  const children = [f.developerGrant.token, f.reviewerGrant.token].map(
    (token) =>
      fork(new URL('./fixtures/task-claim-worker.ts', import.meta.url), [], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          PATH: process.env.PATH ?? '',
          TASK_TEST_DATABASE: f.dbPath,
          TASK_TEST_TOKEN: token,
          TASK_TEST_TEAM: f.teamId,
          TASK_TEST_CHANNEL: f.channelId,
          TASK_TEST_TASK: task.id,
        },
      }),
  );
  const timeout = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error('Worker timeout'));
        }, 15000);
        t.unref();
      }),
    ]);
  try {
    await timeout(
      Promise.all(
        children.map(async (child) => {
          const message: unknown = (await once(child, 'message'))[0];
          assert.equal(
            z.object({ ready: z.literal(true) }).safeParse(message).success,
            true,
          );
        }),
      ),
    );
    const results = children.map((child) => once(child, 'message'));
    const exits = children.map((child) => once(child, 'exit'));
    for (const child of children) child.send('go');
    const replies = await timeout(Promise.all(results));
    const outcomes = replies
      .map((args) => {
        const message: unknown = args[0];
        return z
          .object({ outcome: z.enum(['won', 'conflict', 'failed']) })
          .parse(message).outcome;
      })
      .sort();
    assert.deepEqual(outcomes, ['conflict', 'won']);
    await timeout(Promise.all(exits));
    const final = f.tasks.get(f.principal, f.teamId, f.channelId, task.id);
    assert.equal(final.version, 2);
    assert.ok(
      [f.agent.id, f.reviewer.id].some((id) => id === final.state.owner?.id),
    );
    assert.equal(
      f.tasks
        .history(f.principal, f.teamId, f.channelId, task.id)
        .items.filter((e) => e.action === 'claim').length,
      1,
    );
    assert.equal(
      f.comm
        .events(f.principal, f.teamId, f.channelId)
        .items.filter(
          (e) =>
            e.fact.kind === 'task.changed' && e.fact.taskAction === 'claim',
        ).length,
      1,
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
      }
    }
    await f.dispose();
  }
});

await test('task operation receipts survive replay, are actor/action/target scoped, reject collisions and stale CAS without duplicate effects', async () => {
  const f = await taskFixture();
  try {
    const input = taskInput();
    const created = f.tasks.create(f.principal, f.teamId, f.channelId, input);
    assert.deepEqual(
      f.tasks.create(f.principal, f.teamId, f.channelId, input),
      created,
    );
    assert.throws(
      () =>
        f.tasks.create(f.principal, f.teamId, f.channelId, {
          ...input,
          title: 'Changed',
        }),
      rejected(409),
    );
    const command = commandInput(created.task, { type: 'claim' });
    const claimed = f.tasks.command(
      f.developer,
      f.teamId,
      f.channelId,
      created.task.id,
      command,
    );
    assert.deepEqual(
      f.tasks.command(
        f.developer,
        f.teamId,
        f.channelId,
        created.task.id,
        command,
      ),
      claimed,
    );
    assert.throws(
      () =>
        f.tasks.command(f.developer, f.teamId, f.channelId, created.task.id, {
          ...command,
          expectedVersion: 2,
        }),
      rejected(409),
    );
    const progress = commandInput(claimed.task, {
      type: 'progress',
      note: 'Original',
    });
    if (progress.type !== 'progress')
      throw new Error('Expected progress command');
    const progressed = f.tasks.command(
      f.developer,
      f.teamId,
      f.channelId,
      created.task.id,
      progress,
    );
    assert.throws(
      () =>
        f.tasks.command(f.developer, f.teamId, f.channelId, created.task.id, {
          ...progress,
          note: 'Changed',
        }),
      rejected(409),
    );
    assert.deepEqual(
      f.tasks.command(
        f.developer,
        f.teamId,
        f.channelId,
        created.task.id,
        command,
      ),
      claimed,
    );
    const another = f.create().task;
    assert.equal(
      f.tasks.command(f.developer, f.teamId, f.channelId, another.id, {
        ...command,
        expectedVersion: 1,
      }).task.id,
      another.id,
    );
    assert.throws(
      () =>
        f.tasks.command(
          f.reviewPrincipal,
          f.teamId,
          f.channelId,
          created.task.id,
          command,
        ),
      rejected(409),
    );
    assert.throws(
      () =>
        f.tasks.command(f.developer, f.teamId, f.channelId, created.task.id, {
          type: 'progress',
          expectedVersion: 2,
          operationKey: key(),
          note: 'Stale',
        }),
      rejected(409),
    );
    assert.equal(
      f.tasks.get(f.principal, f.teamId, f.channelId, created.task.id).version,
      progressed.task.version,
    );
  } finally {
    await f.dispose();
  }
});

await test('external execution links are multiple immutable references and never provider status or task acceptance', async () => {
  const f = await taskFixture();
  try {
    let task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
    const command = commandInput(task, {
      type: 'link-execution',
      reference: {
        backend: 't3',
        environmentId: 'external-environment',
        threadId: 'external-thread',
        runId: 'run-one',
      },
      note: 'Execution evidence reference only',
    });
    const first = f.tasks.command(
      f.developer,
      f.teamId,
      f.channelId,
      task.id,
      command,
    );
    task = first.task;
    assert.equal(task.state.status, 'in-progress');
    assert.deepEqual(
      f.tasks.command(f.developer, f.teamId, f.channelId, task.id, command),
      first,
    );
    task = f.act(f.developer, task, {
      type: 'link-execution',
      reference: {
        backend: 't3',
        environmentId: 'external-environment',
        threadId: 'external-thread',
        runId: 'run-two',
      },
      note: 'Another execution',
    }).task;
    assert.equal(task.state.status, 'in-progress');
    assert.equal(
      f.tasks.executions(f.principal, f.teamId, f.channelId, task.id).items
        .length,
      2,
    );
    assert.throws(
      () =>
        f.act(f.developer, task, {
          type: 'link-execution',
          reference:
            command.type === 'link-execution'
              ? command.reference
              : { backend: 't3', environmentId: 'unused', threadId: 'unused' },
          note: 'Duplicate',
        }),
      rejected(409),
    );
    assert.equal(
      TaskCommand.safeParse({ ...command, status: 'completed', accept: true })
        .success,
      false,
    );
    const response = await f.app.inject({
      url: f.taskPath + '/' + task.id + '/executions',
      headers: f.developerHeaders,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      pageOf(TaskExecution).parse(response.json<unknown>()).items.length,
      2,
    );
  } finally {
    await f.dispose();
  }
});

await test('assigned reviewer/owner and designated current human owner control decisions, never arbitrary channel humans or descriptive roles', async () => {
  const f = await taskFixture();
  const raw = new Database(f.dbPath);
  try {
    let task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
    task = f.act(f.developer, task, {
      type: 'request-review',
      reviewer: { kind: 'agent', id: f.reviewer.id },
      note: 'Review',
    }).task;
    assert.throws(
      () =>
        f.act(f.developer, task, {
          type: 'review',
          decision: 'approve',
          note: 'Self approve',
        }),
      rejected(403),
    );
    assert.throws(
      () =>
        f.act(f.principal, task, {
          type: 'review',
          decision: 'approve',
          note: 'Unassigned owner reviewer',
        }),
      rejected(403),
    );
    task = f.act(f.reviewPrincipal, task, {
      type: 'review',
      decision: 'approve',
      note: 'Assigned reviewer approves',
    }).task;
    for (const role of ['member', 'owner'] as const) {
      const humanId = HumanId.parse(randomUUID());
      const account = f.store.credentials('owner');
      assert.ok(account);
      raw
        .prepare('INSERT INTO humans VALUES (?,?,?)')
        .run(humanId, 'other-' + role, account.passwordHash);
      raw
        .prepare('INSERT INTO memberships VALUES (?,?,?)')
        .run(humanId, f.teamId, role);
      f.comm.enroll(
        f.principal,
        f.teamId,
        f.channelId,
        { operationKey: key(), member: { kind: 'human', id: humanId } },
        'invite',
      );
      const login = await f.app.inject({
        method: 'POST',
        url: '/api/login',
        payload: {
          username: 'other-' + role,
          password: 'a long owner test password',
        },
      });
      const cookie = login.cookies[0];
      assert.ok(cookie);
      const cookies = { [cookie.name]: cookie.value };
      for (const action of ['accept', 'rework', 'cancel'])
        assert.equal(
          (
            await f.app.inject({
              method: 'POST',
              url: f.taskPath + '/' + task.id + '/' + action,
              cookies,
              payload: {
                operationKey: key(),
                expectedVersion: task.version,
                note: 'Not designated',
              },
            })
          ).statusCode,
          403,
        );
    }
    raw
      .prepare("UPDATE memberships SET role='member' WHERE human_id=?")
      .run(f.owner.id);
    assert.throws(
      () =>
        f.act(f.principal, task, {
          type: 'accept',
          note: 'Lost owner membership',
        }),
      rejected(403),
    );
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('all task reads/writes enforce team/channel access; missing task IDs and cross-channel references are hidden', async () => {
  const f = await taskFixture();
  try {
    const task = f.create().task;
    const other = f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'Private',
    });
    for (const suffix of ['', '/history', '/executions'])
      assert.equal(
        (
          await f.app.inject({
            url:
              f.taskPath.replace(f.channelId, other.id) +
              '/' +
              task.id +
              suffix,
            headers: f.developerHeaders,
          })
        ).statusCode,
        404,
      );
    assert.equal(
      (
        await f.app.inject({
          url: f.taskPath + '/' + randomUUID(),
          headers: f.developerHeaders,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          url: f.taskPath.replace(f.teamId, randomUUID()),
          headers: f.developerHeaders,
        })
      ).statusCode,
      403,
    );
    f.comm.enroll(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), member: { kind: 'agent', id: f.agent.id } },
      'remove',
    );
    assert.throws(
      () => f.tasks.list(f.developer, f.teamId, f.channelId),
      rejected(404),
    );
    assert.throws(
      () =>
        f.tasks.command(
          f.developer,
          f.teamId,
          f.channelId,
          task.id,
          commandInput(task, { type: 'claim' }),
        ),
      rejected(404),
    );
    const topic = f.comm.createTopic(f.principal, f.teamId, other.id, {
      operationKey: key(),
      title: 'Different channel',
    });
    assert.throws(() => f.create({ topicId: topic.id }), rejected(404));
  } finally {
    await f.dispose();
  }
});

await test('revocation and disable block every task route and stale principals, including historical receipt replay', async () => {
  const f = await taskFixture();
  try {
    const task = f.create().task;
    const command = commandInput(task, { type: 'claim' });
    f.tasks.command(f.developer, f.teamId, f.channelId, task.id, command);
    f.store.agents.revoke(
      f.principal,
      f.teamId,
      f.agent.id,
      f.developerGrant.grant.id,
    );
    const check = async (headers: Record<string, string>) => {
      for (const url of [
        f.taskPath,
        f.taskPath + '/' + task.id,
        f.taskPath + '/' + task.id + '/history',
        f.taskPath + '/' + task.id + '/executions',
      ])
        assert.equal((await f.app.inject({ url, headers })).statusCode, 401);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: f.taskPath,
            headers,
            payload: taskInput(),
          })
        ).statusCode,
        401,
      );
      const bodies = {
        claim: {},
        progress: { note: 'No' },
        handoff: {
          recipient: { kind: 'agent', id: f.reviewer.id },
          mode: 'work',
          note: 'No',
        },
        'request-review': {
          reviewer: { kind: 'agent', id: f.reviewer.id },
          note: 'No',
        },
        review: { decision: 'approve', note: 'No' },
        accept: { note: 'No' },
        rework: { note: 'No' },
        cancel: { note: 'No' },
        'link-execution': {
          reference: {
            backend: 't3',
            environmentId: 'env',
            threadId: 'thread',
          },
          note: 'No',
        },
      };
      for (const [type, body] of Object.entries(bodies))
        assert.equal(
          (
            await f.app.inject({
              method: 'POST',
              url: f.taskPath + '/' + task.id + '/' + type,
              headers,
              payload: { operationKey: key(), expectedVersion: 2, ...body },
            })
          ).statusCode,
          401,
        );
    };
    await check(f.developerHeaders);
    assert.throws(
      () =>
        f.tasks.command(f.developer, f.teamId, f.channelId, task.id, command),
      rejected(401),
    );
    f.store.agents.lifecycle(f.principal, f.teamId, f.reviewer.id, 'disabled');
    await check(f.reviewerHeaders);
  } finally {
    await f.dispose();
  }
});

await test('task scope separation and filtered shared outbox prevent channel-only grants from reading task facts or decisions', async () => {
  const f = await taskFixture();
  try {
    let task = f.create().task;
    assert.equal(
      (await f.app.inject({ url: f.taskPath, headers: f.headers })).statusCode,
      403,
    );
    const limited = f.comm.events(f.agentPrincipal, f.teamId, f.channelId);
    assert.equal(
      limited.items.some((e) => e.fact.kind === 'task.changed'),
      false,
    );
    const hiddenFact = f.comm
      .events(f.principal, f.teamId, f.channelId)
      .items.find((e) => e.fact.kind === 'task.changed');
    assert.ok(hiddenFact);
    assert.throws(
      () =>
        f.comm.post(
          f.agentPrincipal,
          f.teamId,
          f.channelId,
          postInput({ sourceEventId: hiddenFact.fact.id }),
        ),
      rejected(404),
    );

    assert.equal(
      f.comm
        .events(f.developer, f.teamId, f.channelId)
        .items.some((e) => e.fact.kind === 'task.changed'),
      true,
    );
    const onlyWrite = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
      label: 'Missing read',
      scopes: ['channels:read', 'tasks:write'],
      lifetimeSeconds: 3600,
    });
    assert.throws(
      () =>
        f.tasks.get(
          f.store.agents.resolveToken(onlyWrite.token),
          f.teamId,
          f.channelId,
          task.id,
        ),
      rejected(403),
    );
    task = f.act(f.developer, task, { type: 'claim' }).task;
    task = f.act(f.developer, task, {
      type: 'request-review',
      reviewer: { kind: 'agent', id: f.reviewer.id },
      note: 'Review',
    }).task;
    const onlyRead = f.store.agents.issue(
      f.principal,
      f.teamId,
      f.reviewer.id,
      {
        label: 'Missing review',
        scopes: ['channels:read', 'tasks:read', 'tasks:write'],
        lifetimeSeconds: 3600,
      },
    );
    assert.throws(
      () =>
        f.act(f.store.agents.resolveToken(onlyRead.token), task, {
          type: 'review',
          decision: 'approve',
          note: 'No review scope',
        }),
      rejected(403),
    );
  } finally {
    await f.dispose();
  }
});

await test('strict task HTTP input, size bounds, actor spoofing and mixed authority reject invalid requests without secret echo', async () => {
  const f = await taskFixture();
  try {
    const task = f.create().task;
    for (const headers of [
      { ...f.developerHeaders, 'x-kinmesh-actor': f.owner.id },
    ])
      assert.equal(
        (await f.app.inject({ url: f.taskPath, headers })).statusCode,
        400,
      );
    assert.equal(
      (
        await f.app.inject({
          url: f.taskPath + '?actor=' + f.owner.id,
          headers: f.developerHeaders,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          url: f.taskPath,
          headers: f.developerHeaders,
          cookies: f.cookies,
        })
      ).statusCode,
      400,
    );
    for (const payload of [
      { ...taskInput(), acceptorHumanId: f.owner.id },
      { ...taskInput(), creator: { kind: 'human', humanId: f.owner.id } },
      { ...taskInput(), criteria: [] },
      { ...taskInput(), description: 'secret-canary'.repeat(5000) },
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url: f.taskPath,
        cookies: f.cookies,
        payload,
      });
      assert.ok([400, 413].includes(response.statusCode));
      assert.equal(response.body.includes('secret-canary'), false);
    }
    for (const payload of [
      { operationKey: key() },
      { operationKey: key(), expectedVersion: 1, type: 'accept' },
      { operationKey: key(), expectedVersion: 1, actorId: f.owner.id },
    ])
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: f.taskPath + '/' + task.id + '/claim',
            headers: f.developerHeaders,
            payload,
          })
        ).statusCode,
        400,
      );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.taskPath + '/' + task.id + '/accept',
          cookies: f.cookies,
          payload: {
            operationKey: key(),
            expectedVersion: 1,
            note: 'Before review',
          },
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.dispose();
  }
});

await test('task CAS, audit, link and shared outbox roll back together on injected failures and enforce immutable history', async () => {
  const f = await taskFixture();
  const raw = new Database(f.dbPath);
  try {
    const created = f.create();
    const task = created.task;
    const before = f.comm.events(f.principal, f.teamId, f.channelId).items
      .length;
    const command = commandInput(task, { type: 'claim' });
    raw.exec(
      "CREATE TRIGGER fail_task_audit BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    );
    assert.throws(() =>
      f.tasks.command(f.developer, f.teamId, f.channelId, task.id, command),
    );
    assert.equal(
      f.tasks.get(f.principal, f.teamId, f.channelId, task.id).state.status,
      'proposed',
    );
    assert.equal(
      f.comm.events(f.principal, f.teamId, f.channelId).items.length,
      before,
    );
    raw.exec('DROP TRIGGER fail_task_audit');
    const claimed = f.tasks.command(
      f.developer,
      f.teamId,
      f.channelId,
      task.id,
      command,
    ).task;
    raw.exec(
      "CREATE TRIGGER fail_task_outbox BEFORE INSERT ON communication_outbox BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    );
    assert.throws(() =>
      f.act(f.developer, claimed, {
        type: 'link-execution',
        reference: { backend: 't3', environmentId: 'env', threadId: 'thread' },
        note: 'Not persisted',
      }),
    );
    assert.equal(
      f.tasks.executions(f.principal, f.teamId, f.channelId, task.id).items
        .length,
      0,
    );
    assert.equal(
      f.tasks.get(f.principal, f.teamId, f.channelId, task.id).version,
      2,
    );
    assert.throws(() => f.create());
    raw.exec('DROP TRIGGER fail_task_outbox');
    raw.exec(
      "CREATE TRIGGER fail_task_receipt BEFORE INSERT ON communication_operations BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    );
    assert.throws(() =>
      f.act(f.developer, claimed, { type: 'progress', note: 'Not persisted' }),
    );
    assert.equal(
      f.tasks.get(f.principal, f.teamId, f.channelId, task.id).version,
      2,
    );
    raw.exec('DROP TRIGGER fail_task_receipt');
    for (const sql of [
      "UPDATE tasks SET criteria='[]'",
      'UPDATE tasks SET owner_key=NULL',
      'UPDATE task_events SET event=event',
      'DELETE FROM task_events',
      'DELETE FROM tasks',
    ])
      assert.throws(() => raw.exec(sql));
    const fact = f.comm
      .events(f.principal, f.teamId, f.channelId)
      .items.find((e) => e.fact.id === created.eventId);
    assert.ok(fact);
    assert.equal(TaskFact.safeParse(fact.fact).success, true);
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('task/history/execution snapshot pages are bounded and stable under interleaved creation and progress', async () => {
  const f = await taskFixture();
  try {
    const originals = Array.from({ length: 5 }, () => f.create().task);
    const first = f.tasks.list(f.developer, f.teamId, f.channelId, {
      limit: 2,
    });
    assert.ok(first.nextCursor);
    const cursor = first.nextCursor;
    const other = f.open();
    try {
      other.tasks.create(f.principal, f.teamId, f.channelId, taskInput());
    } finally {
      other.close();
    }
    const rest = f.tasks.list(f.developer, f.teamId, f.channelId, {
      cursor,
      limit: 100,
    });
    assert.deepEqual(
      [...first.items, ...rest.items].map((t) => t.id),
      originals.map((t) => t.id),
    );
    let task = f.act(f.developer, originals[0] ?? f.create().task, {
      type: 'claim',
    }).task;
    for (let i = 0; i < 3; i++)
      task = f.act(f.developer, task, {
        type: 'progress',
        note: 'Step ' + String(i),
      }).task;
    const history = f.tasks.history(
      f.developer,
      f.teamId,
      f.channelId,
      task.id,
      { limit: 2 },
    );
    assert.ok(history.nextCursor);
    const hc = history.nextCursor;
    task = f.act(f.developer, task, { type: 'progress', note: 'Later' }).task;
    assert.equal(
      f.tasks.history(f.developer, f.teamId, f.channelId, task.id, {
        cursor: hc,
      }).items.length,
      3,
    );
    assert.throws(
      () =>
        f.tasks.history(f.reviewPrincipal, f.teamId, f.channelId, task.id, {
          cursor: hc,
        }),
      rejected(400),
    );
    assert.throws(
      () =>
        f.tasks.executions(f.developer, f.teamId, f.channelId, task.id, {
          cursor: hc,
        }),
      rejected(400),
    );
    assert.equal(
      (
        await f.app.inject({
          url: f.taskPath + '?limit=101',
          headers: f.developerHeaders,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.dispose();
  }
});

await test('service reopen preserves task ownership/criteria/review decisions, execution refs, outbox and exact receipts without T3', async () => {
  const f = await taskFixture();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    let task = f.create({ owner: { kind: 'agent', id: f.agent.id } }).task;
    task = f.act(f.developer, task, {
      type: 'link-execution',
      reference: {
        backend: 't3',
        environmentId: 'env',
        threadId: 'thread',
        runId: 'run',
      },
      note: 'Reference',
    }).task;
    const command = commandInput(task, {
      type: 'request-review',
      reviewer: { kind: 'agent', id: f.reviewer.id },
      note: 'Persist review',
    });
    const result = f.tasks.command(
      f.developer,
      f.teamId,
      f.channelId,
      task.id,
      command,
    );
    task = result.task;
    const history = f.tasks.history(
      f.principal,
      f.teamId,
      f.channelId,
      task.id,
    );
    const facts = f.comm.events(f.principal, f.teamId, f.channelId);
    await f.app.close();
    const store = f.open();
    app = await createApp(f.config, store);
    const response = await app.inject({
      url: f.taskPath + '/' + task.id,
      headers: f.developerHeaders,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Task.parse(response.json<unknown>()), task);
    assert.deepEqual(
      store.tasks.command(
        store.agents.resolveToken(f.developerGrant.token),
        f.teamId,
        f.channelId,
        task.id,
        command,
      ),
      result,
    );
    assert.deepEqual(
      store.tasks.history(f.principal, f.teamId, f.channelId, task.id),
      history,
    );
    assert.deepEqual(
      store.communication.events(f.principal, f.teamId, f.channelId),
      facts,
    );
    assert.equal(
      store.tasks.executions(f.principal, f.teamId, f.channelId, task.id).items
        .length,
      1,
    );
  } finally {
    if (app !== undefined) await app.close();
    await f.dispose();
  }
});

await test('designated human can recover disabled-owner responsibility with an audited work handoff and fresh review', async () => {
  const f = await taskFixture();
  try {
    let task = f.act(f.developer, f.create().task, { type: 'claim' }).task;
    task = f.act(f.developer, task, {
      type: 'request-review',
      reviewer: { kind: 'agent', id: f.reviewer.id },
      note: 'Review before disable',
    }).task;
    f.store.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'disabled');
    assert.throws(
      () =>
        f.act(f.developer, task, { type: 'progress', note: 'Old credential' }),
      rejected(401),
    );
    const response = await f.app.inject({
      method: 'POST',
      url: f.taskPath + '/' + task.id + '/handoff',
      cookies: f.cookies,
      payload: {
        operationKey: key(),
        expectedVersion: task.version,
        mode: 'work',
        recipient: { kind: 'agent', id: f.reviewer.id },
        note: 'Human recovers disabled owner',
      },
    });
    assert.equal(response.statusCode, 200);
    task = TaskResult.parse(response.json<unknown>()).task;
    assert.equal(task.state.status, 'in-progress');
    assert.deepEqual(task.state.owner, { kind: 'agent', id: f.reviewer.id });
    assert.equal(task.state.reviewer, null);
    assert.equal(task.acceptorHumanId, f.owner.id);
    const history = f.tasks.history(
      f.principal,
      f.teamId,
      f.channelId,
      task.id,
    ).items;
    const last = history.at(-1);
    assert.equal(last?.author.kind, 'human');
    assert.deepEqual(last.before?.state.owner, principalMember(f.developer));
    assert.deepEqual(last.after.state.owner, task.state.owner);
    task = f.act(f.reviewPrincipal, task, {
      type: 'progress',
      note: 'Resumed by new owner',
    }).task;
    assert.throws(
      () =>
        f.act(f.principal, task, {
          type: 'accept',
          note: 'Review must restart',
        }),
      rejected(409),
    );
  } finally {
    await f.dispose();
  }
});
