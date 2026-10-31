import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import {
  writeFileSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadAgentToken, TeamEndpoint } from '../src/team-mcp/client.js';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { taskFixture, commandInput, taskInput } from './task-helpers.js';
import { key, postInput } from './communication-helpers.js';
import {
  freePort,
  startTeam,
  stop,
  connectTeam,
  call,
} from './team-mcp-helpers.js';
import {
  Task,
  TaskResult,
  TaskEvent,
  TaskExecution,
} from '../src/domain/tasks.js';
import {
  ChannelView,
  Message,
  Topic,
  pageOf,
} from '../src/domain/communication.js';
import { teamConfig } from '../src/team-mcp/config.js';
import { TeamId } from '../src/domain/contracts.js';
import { outcome } from '../src/team-mcp/tools.js';

async function fixture() {
  const f = await taskFixture();
  const writer = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
    label: 'Team SDK',
    scopes: ['channels:read', 'channels:write', 'tasks:read', 'tasks:write'],
    lifetimeSeconds: 3600,
  });
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${String(port)}/mcp`;
  let process = await startTeam(f.dbPath, port);
  const connections: Awaited<ReturnType<typeof connectTeam>>[] = [];
  return {
    ...f,
    writer,
    port,
    endpoint,
    async connect(token = writer.token) {
      const c = await connectTeam(endpoint, token);
      connections.push(c);
      return c;
    },
    async restart() {
      await stop(process);
      process = await startTeam(f.dbPath, port);
    },
    async cleanup() {
      for (const c of connections) await c.client.close();
      await stop(process);
      await f.dispose();
    },
  };
}
const denied401 = (e: unknown) =>
  e instanceof StreamableHTTPError && e.code === 401;
await test('real Team MCP subprocess + independent SDK initializes, notifies, lists, pings, posts and performs developer/reviewer handoff without human acceptance', async () => {
  const f = await fixture();
  try {
    const { client, transport, statuses } = await f.connect();
    assert.equal(transport.sessionId, undefined);
    await client.ping();
    await client.notification({ method: 'notifications/initialized' });
    assert.ok(statuses.includes(202)); // SDK initialized notification acknowledged, without a session ID.
    const tools = await client.listTools();
    assert.ok(
      tools.tools.some(
        (t) => t.name === 'team_messages_send' && t.outputSchema !== undefined,
      ),
    );
    assert.ok(!tools.tools.some((t) => /accept|cancel|rework$/.test(t.name)));
    const channels = await call(
      client,
      'team_channels_list',
      {},
      pageOf(ChannelView),
    );
    assert.ok(
      channels.ok && channels.data.items.some((c) => c.id === f.channelId),
    );
    const input = {
      channelId: f.channelId,
      ...postInput({ body: 'SDK test message' }),
    };
    const sent = await call(client, 'team_messages_send', input, Message);
    assert.ok(sent.ok);
    assert.equal(sent.data.author.kind, 'agent');
    assert.equal(sent.data.author.agentId, f.agent.id);
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items[0]?.id,
      sent.data.id,
    );
    assert.deepEqual(
      await call(client, 'team_messages_send', input, Message),
      sent,
    );
    const conflict = await call(
      client,
      'team_messages_send',
      { ...input, body: 'Changed' },
      Message,
    );
    assert.ok(!conflict.ok && conflict.error.code === 'conflict');
    let task = f.create().task;
    const claimed = await call(
      client,
      'team_task_claim',
      {
        channelId: f.channelId,
        taskId: task.id,
        operationKey: key(),
        expectedVersion: task.version,
      },
      TaskResult,
    );
    assert.ok(claimed.ok);
    task = claimed.data.task;
    const { type: progressType, ...progress } = commandInput(task, {
      type: 'progress',
      note: 'SDK progress',
    });
    assert.equal(progressType, 'progress');
    const progressed = await call(
      client,
      'team_task_progress',
      { channelId: f.channelId, taskId: task.id, ...progress },
      TaskResult,
    );
    assert.ok(progressed.ok);
    task = progressed.data.task;
    const handed = await call(
      client,
      'team_task_handoff',
      {
        channelId: f.channelId,
        taskId: task.id,
        operationKey: key(),
        expectedVersion: task.version,
        mode: 'review',
        recipient: { kind: 'agent', id: f.reviewer.id },
        note: 'Review via SDK',
      },
      TaskResult,
    );
    assert.ok(handed.ok);
    task = handed.data.task;
    assert.deepEqual(task.state.owner, { kind: 'agent', id: f.agent.id });
    const reviewer = await f.connect(f.reviewerGrant.token);
    const reviewed = await call(
      reviewer.client,
      'team_task_review',
      {
        channelId: f.channelId,
        taskId: task.id,
        operationKey: key(),
        expectedVersion: task.version,
        decision: 'approve',
        note: 'Technical only',
      },
      TaskResult,
    );
    assert.ok(reviewed.ok);
    task = reviewed.data.task;
    assert.equal(task.state.status, 'awaiting-human');
    assert.equal(
      f.tasks.get(f.principal, f.teamId, f.channelId, task.id).state.status,
      'awaiting-human',
    );
    await f.restart();
    await client.ping();
    const read = await call(
      client,
      'team_task_get',
      { channelId: f.channelId, taskId: task.id },
      Task,
    );
    assert.ok(read.ok && read.data.state.status === 'awaiting-human');
    const history = await call(
      client,
      'team_tasks_history',
      { channelId: f.channelId, taskId: task.id },
      pageOf(TaskEvent),
    );
    assert.ok(history.ok && history.data.items.length === 5);
  } finally {
    await f.cleanup();
  }
});

await test('Team MCP HTTP boundary rejects unauthenticated/cookie/spoofed/origin/host/query/oversized requests with fixed responses', async () => {
  const f = await fixture();
  try {
    const headers = {
      authorization: 'Bearer ' + f.writer.token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const missing = await fetch(f.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate') ?? '', /^Bearer/);
    for (const bad of [
      { cookie: 'kinmesh=spoof' },
      { 'x-kinmesh-actor': f.owner.id },
      { origin: 'https://attacker.invalid' },
      { host: 'attacker.invalid' },
    ]) {
      const res = await fetch(f.endpoint, {
        method: 'POST',
        headers: { ...headers, ...bad },
        body: '{}',
      });
      assert.ok([400, 403].includes(res.status));
      assert.equal((await res.text()).includes(f.writer.token), false);
    }
    for (const host of [
      `localhost:${String(f.port)}`,
      `[::1]:${String(f.port)}`,
    ]) {
      const response = await fetch(f.endpoint, {
        method: 'POST',
        headers: { ...headers, host },
        body: '{}',
      });
      // Fastify may reject the Host syntax before the application allowlist.
      assert.ok([400, 403].includes(response.status));
      assert.equal((await response.text()).includes(f.writer.token), false);
    }
    assert.equal(
      (
        await fetch(f.endpoint + '?actorId=' + f.owner.id, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(f.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ huge: 'x'.repeat(20000) }),
        })
      ).status,
      413,
    );
    const get = await fetch(f.endpoint, { headers });
    assert.equal(get.status, 405);
    const remove = await fetch(f.endpoint, {
      method: 'DELETE',
      headers: { authorization: headers.authorization },
    });
    assert.equal(remove.status, 405);
  } finally {
    await f.cleanup();
  }
});

await test('Team SDK strict input/output schemas reject impersonation and unknown tools; schema discovery is not mutation authority', async () => {
  const f = await fixture();
  try {
    const { client } = await f.connect();
    const listed = await client.listTools();
    assert.ok(
      listed.tools.every(
        (t) =>
          t.inputSchema.additionalProperties === false &&
          t.outputSchema !== undefined,
      ),
    );
    for (const args of [
      { channelId: f.channelId, actorId: f.owner.id },
      { channelId: 123 },
      { channelId: f.channelId, limit: 0 },
    ]) {
      const result = await client.callTool({
        name: 'team_messages_read',
        arguments: args,
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined); // SDK schema errors are not domain result envelopes.
    }
    assert.equal(
      (await client.callTool({ name: 'team_task_accept', arguments: {} }))
        .isError,
      true,
    );
    const readonly = await f.connect(f.credential.token); // channels read/write, no task scopes
    const read = await call(
      readonly.client,
      'team_tasks_list',
      { channelId: f.channelId },
      pageOf(Task),
    );
    assert.ok(!read.ok && read.error.code === 'forbidden');
    const grant = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
      label: 'Read only SDK',
      scopes: ['channels:read'],
      lifetimeSeconds: 3600,
    });
    const r = await f.connect(grant.token);
    const denied = await call(
      r.client,
      'team_messages_send',
      { channelId: f.channelId, ...postInput() },
      Message,
    );
    assert.ok(!denied.ok && denied.error.code === 'forbidden');
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      0,
    );
    assert.equal(
      outcome(Message).safeParse({
        result: { ok: true, data: { body: 'invented' } },
      }).success,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

await test('Team SDK hides cross-team/channel context, enforces current membership and assigned task/reviewer authority', async () => {
  const f = await fixture();
  try {
    const { client } = await f.connect();
    const otherTeam = TeamId.parse(randomUUID());
    const foreign = new Database(f.dbPath);
    foreign
      .prepare('INSERT INTO teams (id,name) VALUES (?,?)')
      .run(otherTeam, 'Other team');
    foreign
      .prepare('INSERT INTO memberships (human_id,team_id,role) VALUES (?,?,?)')
      .run(f.owner.id, otherTeam, 'owner');
    foreign.close();
    const foreignChannel = f.comm.createChannel(f.principal, otherTeam, {
      operationKey: key(),
      name: 'Foreign channel',
    });
    const foreignRead = await call(
      client,
      'team_messages_read',
      { channelId: foreignChannel.id },
      pageOf(Message),
    );
    assert.ok(!foreignRead.ok && foreignRead.error.code === 'not_found');
    const privateChannel = f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'private',
    });
    const hidden = await call(
      client,
      'team_messages_read',
      { channelId: privateChannel.id },
      pageOf(Message),
    );
    assert.ok(!hidden.ok && hidden.error.code === 'not_found');
    const task = f.create().task;
    const noOwner = await call(
      client,
      'team_task_progress',
      {
        channelId: f.channelId,
        taskId: task.id,
        operationKey: key(),
        expectedVersion: 1,
        note: 'Spoof owner',
      },
      TaskResult,
    );
    assert.ok(!noOwner.ok && noOwner.error.code === 'forbidden');
    const wrongReviewer = await call(
      client,
      'team_task_review',
      {
        channelId: f.channelId,
        taskId: task.id,
        operationKey: key(),
        expectedVersion: 1,
        note: 'No review grant',
        decision: 'approve',
      },
      TaskResult,
    );
    assert.ok(!wrongReviewer.ok && wrongReviewer.error.code === 'forbidden');
    const cross = await client.callTool({
      name: 'team_channels_list',
      arguments: { teamId: randomUUID() },
    });
    assert.equal(cross.isError, true);
    f.comm.enroll(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), member: { kind: 'agent', id: f.agent.id } },
      'remove',
    );
    const removed = await call(
      client,
      'team_task_get',
      { channelId: f.channelId, taskId: task.id },
      Task,
    );
    assert.ok(!removed.ok && removed.error.code === 'not_found');
  } finally {
    await f.cleanup();
  }
});

await test('Team MCP revocation, disable and expiry reject existing SDK connections and reconnects at HTTP authentication', async () => {
  const f = await fixture();
  try {
    const { client } = await f.connect();
    const advertised = await client.listTools();
    f.store.agents.revoke(f.principal, f.teamId, f.agent.id, f.writer.grant.id);
    await assert.rejects(() => client.ping(), denied401);
    for (const tool of advertised.tools)
      await assert.rejects(
        () => client.callTool({ name: tool.name, arguments: {} }),
        denied401,
      );
    await assert.rejects(() => f.connect(), denied401);
    const old = await f.connect(f.developerGrant.token);
    f.store.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'disabled');
    await assert.rejects(() => old.client.listTools(), denied401);
    for (const tool of advertised.tools)
      await assert.rejects(
        () => old.client.callTool({ name: tool.name, arguments: {} }),
        denied401,
      );
    const reviewer = await f.connect(f.reviewerGrant.token);
    const db = new Database(f.dbPath);
    db.prepare('UPDATE agent_grants SET expires_at=? WHERE id=?').run(
      '2000-01-01T00:00:00.000Z',
      f.reviewerGrant.grant.id,
    );
    db.close();
    await assert.rejects(() => reviewer.client.ping(), denied401);
    const res = await fetch(f.endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + f.writer.token,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(res.status, 401);
  } finally {
    await f.cleanup();
  }
});

await test('two independent official SDK client processes race to claim through Team MCP: exactly one winner with one audit/fact', async () => {
  const f = await fixture();
  const children: ReturnType<typeof fork>[] = [];
  const deadline = async <T>(p: Promise<T>) => {
    const t = AbortSignal.timeout(12000);
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t.addEventListener(
          'abort',
          () => {
            reject(new Error('SDK worker timeout'));
          },
          { once: true },
        );
      }),
    ]);
  };
  try {
    const task = f.create().task;
    for (const token of [f.writer.token, f.reviewerGrant.token])
      children.push(
        fork(
          new URL('./fixtures/team-mcp-claim-worker.ts', import.meta.url),
          [],
          {
            execArgv: ['--import', 'tsx'],
            env: {
              ...process.env,
              TEAM_TEST_ENDPOINT: f.endpoint,
              TEAM_TEST_TOKEN: token,
              TEAM_TEST_CHANNEL: f.channelId,
              TEAM_TEST_TASK: task.id,
            },
            silent: true,
          },
        ),
      );
    for (const c of children) {
      c.stdout?.resume();
      c.stderr?.resume();
    }
    await deadline(
      Promise.all(
        children.map(async (c) => {
          const msg: unknown = (await once(c, 'message'))[0];
          assert.equal(
            z.object({ ready: z.literal(true) }).safeParse(msg).success,
            true,
          );
        }),
      ),
    );
    const replies = children.map((c) => once(c, 'message'));
    const exits = children.map((c) => once(c, 'exit'));
    for (const c of children) c.send('go');
    const results = await deadline(Promise.all(replies));
    assert.deepEqual(
      results
        .map(([msg]) => z.object({ outcome: z.string() }).parse(msg).outcome)
        .sort(),
      ['conflict', 'won'],
    );
    await deadline(Promise.all(exits));
    assert.equal(
      f.tasks.get(f.principal, f.teamId, f.channelId, task.id).version,
      2,
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
    for (const c of children) await stop(c);
    await f.cleanup();
  }
});

await test('Team MCP transactions roll back on outbox failure and retries recover same original result', async () => {
  const f = await fixture();
  try {
    const { client } = await f.connect();
    const db = new Database(f.dbPath);
    db.exec(
      "CREATE TRIGGER test_mcp_failure BEFORE INSERT ON communication_outbox BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    const input = { channelId: f.channelId, ...postInput() };
    const failure = await call(client, 'team_messages_send', input, Message);
    assert.ok(!failure.ok && failure.error.code === 'conflict');
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      0,
    );
    db.exec('DROP TRIGGER test_mcp_failure');
    db.close();
    const sent = await call(client, 'team_messages_send', input, Message);
    assert.ok(sent.ok);
    assert.deepEqual(
      await call(client, 'team_messages_send', input, Message),
      sent,
    );
    assert.equal(
      f.comm.history(f.principal, f.teamId, f.channelId).items.length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

await test('Team configuration rejects non-TLS external origins and malformed configuration', () => {
  assert.equal(teamConfig({}).port, 3001);
  for (const origin of [
    'http://example.com',
    'https://example.com/path',
    'https://example.com?x=1',
  ])
    assert.throws(() => teamConfig({ KINMESH_TEAM_MCP_ORIGIN: origin }));
  assert.throws(() => teamConfig({ KINMESH_TEAM_MCP_CONCURRENCY: '0' }));
  assert.throws(() => teamConfig({ KINMESH_TEAM_MCP_PORT: '0' }));
});

await test('Team SDK topic/task creation, scoped request-review and external references reuse authoritative domain state; reads have no effects', async () => {
  const f = await fixture();
  try {
    const { client } = await f.connect();
    const topic = await call(
      client,
      'team_topic_create',
      { channelId: f.channelId, operationKey: key(), title: 'SDK topic' },
      Topic,
    );
    assert.ok(topic.ok);
    const created = await call(
      client,
      'team_task_create',
      { channelId: f.channelId, ...taskInput({ topicId: topic.data.id }) },
      TaskResult,
    );
    assert.ok(created.ok);
    const taskId = created.data.task.id;
    let result = await call(
      client,
      'team_task_claim',
      {
        channelId: f.channelId,
        taskId,
        operationKey: key(),
        expectedVersion: 1,
      },
      TaskResult,
    );
    assert.ok(result.ok);
    result = await call(
      client,
      'team_task_link_execution',
      {
        channelId: f.channelId,
        taskId,
        operationKey: key(),
        expectedVersion: 2,
        note: 'Asserted only',
        reference: {
          backend: 't3',
          environmentId: 'test-environment',
          threadId: 'test-thread',
          runId: 'test-run',
        },
      },
      TaskResult,
    );
    assert.ok(result.ok);
    assert.equal(result.data.task.state.status, 'in-progress');
    const requested = await call(
      client,
      'team_task_request_review',
      {
        channelId: f.channelId,
        taskId,
        operationKey: key(),
        expectedVersion: 3,
        note: 'Request review',
        reviewer: { kind: 'agent', id: f.reviewer.id },
      },
      TaskResult,
    );
    assert.ok(requested.ok);
    const db = new Database(f.dbPath);
    const counts = () =>
      [
        'tasks',
        'task_events',
        'task_executions',
        'communication_outbox',
        'communication_operations',
      ].map(
        (table) =>
          z
            .object({ n: z.number() })
            .parse(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()).n,
      );
    const before = counts();
    assert.ok(
      (
        await call(
          client,
          'team_channel_get',
          { channelId: f.channelId },
          ChannelView,
        )
      ).ok,
    );
    assert.ok(
      (
        await call(
          client,
          'team_topics_list',
          { channelId: f.channelId },
          pageOf(Topic),
        )
      ).ok,
    );
    assert.ok(
      (
        await call(
          client,
          'team_messages_read',
          { channelId: f.channelId, topicId: topic.data.id },
          pageOf(Message),
        )
      ).ok,
    );
    assert.ok(
      (
        await call(
          client,
          'team_tasks_list',
          { channelId: f.channelId },
          pageOf(Task),
        )
      ).ok,
    );
    const refs = await call(
      client,
      'team_task_executions',
      { channelId: f.channelId, taskId },
      pageOf(TaskExecution),
    );
    assert.ok(refs.ok && refs.data.items.length === 1);
    assert.deepEqual(counts(), before);
    db.close();
  } finally {
    await f.cleanup();
  }
});

await test('private token loader and real smoke CLI protect credentials', async () => {
  const f = await fixture();
  try {
    const file = join(f.directory, 'agent-token.json');
    writeFileSync(file, JSON.stringify({ token: f.writer.token }), {
      mode: 0o600,
    });
    assert.equal(loadAgentToken(file) === f.writer.token, true);
    chmodSync(file, 0o644);
    assert.throws(() => loadAgentToken(file));
    chmodSync(file, 0o600);
    const symlink = join(f.directory, 'link.json');
    symlinkSync(file, symlink);
    assert.throws(() => loadAgentToken(symlink));
    assert.equal(
      TeamEndpoint.safeParse('https://user:secret@example.com/mcp').success,
      false,
    );
    assert.equal(
      TeamEndpoint.safeParse('http://example.com/mcp').success,
      false,
    );
    assert.equal(
      TeamEndpoint.safeParse('https://example.com/mcp?token=secret').success,
      false,
    );
    const run = async (script: string, env: NodeJS.ProcessEnv) =>
      new Promise<{ code: number | null; log: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script], {
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        child.stdout.on('data', (b: Buffer) => {
          log += b.toString();
        });
        child.stderr.on('data', (b: Buffer) => {
          log += b.toString();
        });
        child.once('error', () => {
          reject(new Error('CLI failed'));
        });
        child.once('exit', (code) => {
          resolve({ code, log });
        });
      });
    const smoke = await run('scripts/team-mcp-smoke.ts', {
      KINMESH_TEAM_MCP_ENDPOINT: f.endpoint,
      KINMESH_TEAM_MCP_TOKEN_FILE: file,
    });
    assert.equal(smoke.code, 0);
    assert.match(smoke.log, /TEAM_MCP_SDK_READ PASS/);
    assert.equal(smoke.log.includes(f.writer.token), false);
  } finally {
    await f.cleanup();
  }
});

for (const cursorCase of ['bad', 'wrong-context'] as const) {
  await test(`real SDK process returns exact redacted invalid_input for ${cursorCase} snapshot cursor`, async () => {
    const f = await fixture();
    try {
      const { client } = await f.connect();
      const marker = 'private-cursor-input-' + randomUUID();
      let cursor = marker;
      let name = 'team_messages_read';
      if (cursorCase === 'wrong-context') {
        for (let i = 0; i < 2; i++)
          f.comm.post(
            f.principal,
            f.teamId,
            f.channelId,
            postInput({ body: marker }),
          );
        const page = await call(
          client,
          'team_messages_read',
          { channelId: f.channelId, limit: 1 },
          pageOf(Message),
        );
        assert.ok(page.ok && page.data.nextCursor !== null);
        cursor = page.data.nextCursor;
        name = 'team_tasks_list'; // Valid server-issued cursor for a different view.
      }
      const raw = await client.callTool({
        name,
        arguments: { channelId: f.channelId, cursor },
      });
      assert.equal(raw.isError, true);
      const serialized = JSON.stringify(raw);
      assert.equal(serialized.includes(marker), false);
      assert.equal(serialized.includes(cursor), false);
      assert.equal(serialized.includes(f.writer.token), false);
      const decoded = outcome(z.unknown()).parse(raw.structuredContent).result;
      assert.deepEqual(decoded, {
        ok: false,
        error: { code: 'invalid_input', message: 'Invalid input' },
      });
    } finally {
      await f.cleanup();
    }
  });
}

await test('Team endpoint plaintext allowlist matches IPv4 listener while HTTPS proxy URLs remain supported', () => {
  for (const endpoint of [
    'http://localhost:3001/mcp',
    'http://[::1]:3001/mcp',
  ]) {
    assert.equal(TeamEndpoint.safeParse(endpoint).success, false);
  }
  assert.equal(
    TeamEndpoint.safeParse('http://127.0.0.1:3001/mcp').success,
    true,
  );
  assert.equal(
    TeamEndpoint.safeParse('https://team.example.com/mcp').success,
    true,
  );
});
