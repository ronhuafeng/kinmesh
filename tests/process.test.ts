import { Task, TaskResult, TaskEvent } from '../src/domain/tasks.js';
import { taskInput } from './task-helpers.js';
import {
  ChannelView,
  Topic,
  Message,
  pageOf,
} from '../src/domain/communication.js';
import { key, postInput } from './communication-helpers.js';
import { z } from 'zod';
import { Agent } from '../src/domain/agents.js';
import { Team, Human } from '../src/domain/contracts.js';
import { profileInput, grantInput, Issued } from './agent-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.js';

await test('setup command creates private secrets, never prints values and refuses overwrite', () => {
  const f = fixture();
  try {
    const script = new URL('../scripts/setup.ts', import.meta.url);
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
        script.pathname,
      ],
      { cwd: f.directory, encoding: 'utf8' },
    );
    const env = readFileSync(join(f.directory, '.env'), 'utf8');
    assert.equal(statSync(join(f.directory, '.env')).mode & 0o777, 0o600);
    const secret = /^KINMESH_SETUP_TOKEN=([a-f0-9]{64})$/m.exec(env)?.[1];
    assert.ok(secret);
    assert.ok(!output.includes(secret));
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          '--import',
          new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
          script.pathname,
        ],
        { cwd: f.directory, stdio: 'ignore' },
      ),
    );
    assert.equal(readFileSync(join(f.directory, '.env'), 'utf8'), env);
  } finally {
    f.cleanup();
  }
});
await test('actual server entrypoint authenticates owner, exchanges messages, completes reviewed human task acceptance and recovers after process restart', async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address !== null && typeof address !== 'string');
  const port = address.port;
  const closed = once(listener, 'close');
  listener.close();
  await closed;
  const f = fixture();
  const start = () =>
    spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
      cwd: new URL('..', import.meta.url),
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH ?? '',
        KINMESH_DATABASE: f.path,
        KINMESH_SETUP_TOKEN: f.config.setupToken,
        KINMESH_SESSION_KEY: f.config.sessionKey.toString('hex'),
        KINMESH_PORT: String(port),
        KINMESH_ORIGIN: `http://127.0.0.1:${String(port)}`,
      },
    });
  let child = start();
  const ready = async () => {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('Server exited before ready');
      }),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Server readiness timeout'));
        }, 10000);
        timer.unref();
      }),
    ]);
  };
  try {
    await ready();
    const origin = `http://127.0.0.1:${String(port)}`;
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.equal((await fetch(origin + '/api/team')).status, 401);
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    const owner = {
      username: 'owner',
      password: 'real-http-test-password-only',
      teamName: 'HTTP team',
    };
    const setup = await post('/api/setup', owner, {
      authorization: 'Bearer ' + f.config.setupToken,
    });
    assert.equal(setup.status, 201);
    const team = z.object({ team: Team }).parse(await setup.json()).team;
    const login = await post('/api/login', {
      username: owner.username,
      password: owner.password,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const created = await post(`/api/teams/${team.id}/agents`, profileInput, {
      cookie,
    });
    assert.equal(created.status, 201);
    const agent = Agent.parse(await created.json());
    const path = `/api/teams/${team.id}/agents/${agent.id}`;
    const issued = await post(
      path + '/grants',
      {
        ...grantInput,
        scopes: [
          ...grantInput.scopes,
          'channels:read',
          'channels:write',
          'tasks:read',
          'tasks:write',
        ],
      },
      { cookie },
    );
    assert.equal(issued.status, 201);
    const grant = Issued.parse(await issued.json());
    const headers = { authorization: 'Bearer ' + grant.token };
    assert.equal((await fetch(origin + path, { headers })).status, 200);
    assert.equal((await fetch(origin + '/api/team', { headers })).status, 403);
    const channelResponse = await post(
      `/api/teams/${team.id}/channels`,
      { operationKey: key(), name: 'HTTP discussion' },
      { cookie },
    );
    assert.equal(channelResponse.status, 201);
    const channel = ChannelView.parse(await channelResponse.json());
    const channelPath = `/api/teams/${team.id}/channels/${channel.id}`;
    assert.equal(
      (
        await post(
          channelPath + '/participants/invite',
          { operationKey: key(), member: { kind: 'agent', id: agent.id } },
          { cookie },
        )
      ).status,
      200,
    );
    const topicResponse = await post(
      channelPath + '/topics',
      { operationKey: key(), title: 'HTTP topic' },
      { cookie },
    );
    assert.equal(topicResponse.status, 201);
    const topic = Topic.parse(await topicResponse.json());
    const humanResponse = await post(
      channelPath + '/messages',
      postInput({
        topicId: topic.id,
        body: 'Human request',
        mentions: [{ kind: 'agent', id: agent.id }],
      }),
      { cookie },
    );
    assert.equal(humanResponse.status, 201);
    const humanMessage = Message.parse(await humanResponse.json());
    const ownerHuman = z
      .object({ human: Human })
      .parse(
        await (await fetch(origin + '/api/me', { headers: { cookie } })).json(),
      ).human;
    const agentResponse = await post(
      channelPath + '/messages',
      postInput({
        topicId: topic.id,
        body: 'Agent reply',
        sourceMessageId: humanMessage.id,
        mentions: [{ kind: 'human', id: ownerHuman.id }],
      }),
      headers,
    );
    assert.equal(agentResponse.status, 201);
    const agentMessage = Message.parse(await agentResponse.json());
    assert.equal(agentMessage.author.kind, 'agent');
    for (const timeline of [
      channelPath + '/messages',
      channelPath + '/topics/' + topic.id + '/messages',
    ]) {
      const response = await fetch(origin + timeline, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(
        pageOf(Message)
          .parse(await response.json())
          .items.map((m) => m.id),
        [humanMessage.id, agentMessage.id],
      );
    }

    const reviewerResponse = await post(
      `/api/teams/${team.id}/agents`,
      { ...profileInput, name: 'HTTP Reviewer', role: 'reviewer' },
      { cookie },
    );
    assert.equal(reviewerResponse.status, 201);
    const reviewer = Agent.parse(await reviewerResponse.json());
    const reviewerGrantResponse = await post(
      `/api/teams/${team.id}/agents/${reviewer.id}/grants`,
      {
        label: 'HTTP reviewer',
        scopes: ['channels:read', 'tasks:read', 'tasks:review'],
        lifetimeSeconds: 3600,
      },
      { cookie },
    );
    assert.equal(reviewerGrantResponse.status, 201);
    const reviewerGrant = Issued.parse(await reviewerGrantResponse.json());
    const reviewHeaders = { authorization: 'Bearer ' + reviewerGrant.token };
    assert.equal(
      (
        await post(
          channelPath + '/participants/invite',
          { operationKey: key(), member: { kind: 'agent', id: reviewer.id } },
          { cookie },
        )
      ).status,
      200,
    );
    const tasksPath = channelPath + '/tasks';
    const createdTask = await post(
      tasksPath,
      taskInput({ topicId: topic.id }),
      { cookie },
    );
    assert.equal(createdTask.status, 201);
    let task = TaskResult.parse(await createdTask.json()).task;
    const claim = await post(
      tasksPath + '/' + task.id + '/claim',
      { operationKey: key(), expectedVersion: task.version },
      headers,
    );
    assert.equal(claim.status, 200);
    task = TaskResult.parse(await claim.json()).task;
    const handoff = await post(
      tasksPath + '/' + task.id + '/handoff',
      {
        operationKey: key(),
        expectedVersion: task.version,
        recipient: { kind: 'agent', id: reviewer.id },
        mode: 'review',
        note: 'Independent review',
      },
      headers,
    );
    assert.equal(handoff.status, 200);
    task = TaskResult.parse(await handoff.json()).task;
    const review = await post(
      tasksPath + '/' + task.id + '/review',
      {
        operationKey: key(),
        expectedVersion: task.version,
        decision: 'approve',
        note: 'Technical feedback',
      },
      reviewHeaders,
    );
    assert.equal(review.status, 200);
    task = TaskResult.parse(await review.json()).task;
    assert.equal(task.state.status, 'awaiting-human');
    const accepted = await post(
      tasksPath + '/' + task.id + '/accept',
      {
        operationKey: key(),
        expectedVersion: task.version,
        note: 'Verified human owner accepts',
      },
      { cookie },
    );
    assert.equal(accepted.status, 200);
    task = TaskResult.parse(await accepted.json()).task;
    assert.equal(task.state.status, 'accepted');
    assert.equal(
      (await post(path + '/lifecycle', { lifecycle: 'disabled' }, { cookie }))
        .status,
      200,
    );
    assert.equal((await fetch(origin + path, { headers })).status, 401);
    assert.equal(
      (await fetch(origin + channelPath + '/messages', { headers })).status,
      401,
    );
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
    assert.equal(child.exitCode, 0);
    await assert.rejects(
      fetch(origin + '/health', { signal: AbortSignal.timeout(1000) }),
    );
    child = start();
    await ready();
    const recovered = await fetch(origin + tasksPath + '/' + task.id, {
      headers: { cookie },
    });
    assert.equal(recovered.status, 200);
    assert.deepEqual(Task.parse(await recovered.json()), task);
    const recoveredHistory = await fetch(
      origin + tasksPath + '/' + task.id + '/history',
      { headers: { cookie } },
    );
    assert.equal(recoveredHistory.status, 200);
    assert.equal(
      pageOf(TaskEvent)
        .parse(await recoveredHistory.json())
        .items.at(-1)?.author.kind,
      'human',
    );
    assert.equal(
      (await fetch(origin + tasksPath + '/' + task.id, { headers })).status,
      401,
    );
    const secondExit = once(child, 'exit');
    child.kill('SIGTERM');
    await secondExit;
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    f.cleanup();
  }
});
