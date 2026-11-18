import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { z } from 'zod';
import { deliver } from '../src/inbox/worker.js';
import {
  spaceProvisioner,
  type FilePlacer,
  type Provisioner,
} from '../src/inbox/space.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { spaceDirectory } from '../src/domain/inbox.js';
import { ExecutionFailure } from '../src/domain/execution.js';
import { assistantRead, due, inboxFixture } from './inbox-helpers.js';
import { key, postInput } from './communication-helpers.js';
import { envelope } from './t3-helpers.js';
import type { TopicId } from '../src/domain/communication.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
const signal = () => new AbortController().signal;
const Args = z.record(z.string(), z.unknown());
/** `t3_project_list` as T3 0.1.9 advertises it. */
const projectList: unknown = JSON.parse(
  readFileSync(
    new URL('./fixtures/t3-0.1.9-project-list.json', import.meta.url),
    'utf8',
  ),
);

async function mention(f: Fixture, topicId: TopicId | null = null) {
  await f.comm.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({ topicId, mentions: [{ kind: 'agent', id: f.agent.id }] }),
  );
}
const calls = (f: Fixture, name: string) =>
  f.wire.calls.filter((c) => c.name === name).map((c) => Args.parse(c.args));
/**
 * T3 with `t3_project_list`, and a provisioner that registers a folder as a
 * project the way the deployment's does: once, whatever it is asked.
 */
function space(f: Fixture) {
  const listed = z
    .object({ tools: z.array(z.unknown()) })
    .loose()
    .parse(f.wire.listValue);
  f.wire.listValue = { ...listed, tools: [...listed.tools, projectList] };
  const projects = new Map<string, string>();
  const list = () => ({
    projects: [...projects].map(([workspaceRoot, id]) => ({
      id,
      title: 'Fixture',
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
      deletedAt: null,
    })),
    nextCursor: null,
  });
  f.wire.values.t3_project_list = list();
  const asked: string[] = [];
  const provisioner: Provisioner = (directory) => {
    asked.push(directory);
    const root = `/space/${directory}`;
    if (!projects.has(root))
      projects.set(root, `project-${String(projects.size + 1)}`);
    f.wire.values.t3_project_list = list();
    return Promise.resolve(root);
  };
  return { asked, provisioner };
}
async function attempt(f: Fixture, provisioner: Provisioner | null) {
  await due(f.dbPath);
  const claim = await f.inbox.claim([f.agent.id]);
  assert.ok(claim);
  await deliver(f.store, claim, f.binding, f.factory, signal(), provisioner);
  return f.inbox.get(claim.id);
}

await test('a channel is a T3 project in the space: its own conversation and every topic are threads in it', async () => {
  const f = await inboxFixture();
  try {
    const { asked, provisioner } = space(f);
    const topic = await f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'Logo',
    });
    f.wire.values.t3_thread_read = assistantRead('Answered');
    for (const where of [null, topic.id]) {
      await mention(f, where);
      const delivery = await attempt(f, provisioner);
      assert.equal(delivery.state, 'acked', delivery.reason);
    }
    // One folder for the channel, named from it, asked for each new thread.
    assert.equal(asked.length, 2);
    assert.equal(new Set(asked).size, 1);
    const channel = await f.comm.channel(f.principal, f.teamId, f.channelId);
    assert.equal(asked[0], spaceDirectory(channel.name, f.channelId));
    // Two threads, both in the channel's project, at its root.
    const launches = calls(f, 't3_thread_launch');
    assert.equal(launches.length, 2);
    for (const launch of launches) {
      assert.equal(launch.projectId, 'project-1');
      assert.deepEqual(launch.workspaceStrategy, { type: 'root' });
      assert.equal(launch.scratch, undefined);
    }
  } finally {
    await f.dispose();
  }
});

await test('once the space is set up, a scratch conversation’s next message starts a thread in the project', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = assistantRead('In scratch');
    assert.equal((await attempt(f, null)).state, 'acked');
    assert.equal(calls(f, 't3_thread_launch')[0]?.scratch, true);

    const { provisioner } = space(f);
    await mention(f);
    f.wire.values.t3_thread_read = assistantRead('In the project');
    const moved = await attempt(f, provisioner);
    assert.equal(moved.state, 'acked', moved.reason);
    // Not sent to the scratch thread: a new one, in the project.
    assert.equal(calls(f, 't3_thread_send').length, 0);
    const launches = calls(f, 't3_thread_launch');
    assert.equal(launches.length, 2);
    assert.equal(launches[1]?.projectId, 'project-1');

    // From then on the conversation continues in that thread.
    await mention(f);
    await attempt(f, provisioner);
    assert.equal(calls(f, 't3_thread_launch').length, 2);
    assert.equal(calls(f, 't3_thread_send').length, 1);
  } finally {
    await f.dispose();
  }
});

await test('a delivery not yet in T3 waits for the provisioner, and blocks when it refuses or T3 has no such project', async () => {
  const f = await inboxFixture();
  try {
    const { provisioner } = space(f);
    await mention(f);
    const down = await attempt(f, () =>
      Promise.reject(new ExecutionFailure('unavailable')),
    );
    assert.equal(down.state, 'ready');
    assert.equal(down.reason, 'temporarily-unavailable');

    const refused = await attempt(f, () =>
      Promise.reject(new ExecutionFailure('permission')),
    );
    assert.equal(refused.state, 'blocked');
    assert.equal(refused.reason, 'native-access');

    await f.inbox.resume(refused.id);
    const missing = await attempt(f, () => Promise.resolve('/space/elsewhere'));
    assert.equal(missing.state, 'blocked');
    assert.equal(missing.reason, 'native-incompatible');
    assert.equal(calls(f, 't3_thread_launch').length, 0);

    await f.inbox.resume(missing.id);
    f.wire.values.t3_thread_read = assistantRead('At last');
    const done = await attempt(f, provisioner);
    assert.equal(done.state, 'acked', done.reason);
  } finally {
    await f.dispose();
  }
});

await test('a launch retried after a lost reply keeps its project and needs no provisioner', async () => {
  const f = await inboxFixture();
  try {
    const { asked, provisioner } = space(f);
    await mention(f);
    f.wire.handler = (name) =>
      name === 't3_thread_launch'
        ? Promise.reject(new Error('lost reply'))
        : Promise.resolve(envelope(f.wire.values[name]));
    const lost = await attempt(f, provisioner);
    assert.equal(lost.state, 'uncertain');
    f.wire.handler = undefined;
    f.wire.values.t3_thread_read = assistantRead('Recovered');
    const recovered = await attempt(f, () =>
      Promise.reject(new ExecutionFailure('unavailable')),
    );
    assert.equal(recovered.state, 'acked', recovered.reason);
    assert.equal(asked.length, 1);
    const keys = calls(f, 't3_thread_launch').map((c) => c.clientRequestId);
    assert.equal(new Set(keys).size, 1);
  } finally {
    await f.dispose();
  }
});

await test('the provisioner client sends its token and reads the folder; a refusal is denial, anything else retryable', async () => {
  const f = await inboxFixture();
  const seen: { auth: string | undefined; body: string }[] = [];
  let status = 200;
  let reply = JSON.stringify({ workspaceRoot: '/space/design-3f2a91c0' });
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push({ auth: request.headers.authorization, body });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(reply);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const tokenFile = join(f.directory, 'space-token');
    const provision = spaceProvisioner({
      endpoint: `http://127.0.0.1:${String(address.port)}`,
      tokenFile,
    });
    // No token yet: the deployment hasn't written it.
    await assert.rejects(
      provision('design-3f2a91c0', 'design', signal()),
      (e: unknown) => e instanceof ExecutionFailure && e.kind === 'unavailable',
    );
    writeFileSync(tokenFile, 'fixture-space-token\n', { mode: 0o600 });
    assert.equal(
      await provision('design-3f2a91c0', 'design', signal()),
      '/space/design-3f2a91c0',
    );
    const [first] = seen;
    assert.ok(first);
    assert.equal(first.auth, 'Bearer fixture-space-token');
    assert.deepEqual(JSON.parse(first.body), {
      directory: 'design-3f2a91c0',
      title: 'design',
    });
    for (const [code, kind] of [
      [401, 'permission'],
      [500, 'unavailable'],
    ] as const) {
      status = code;
      await assert.rejects(
        provision('design-3f2a91c0', 'design', signal()),
        (e: unknown) => e instanceof ExecutionFailure && e.kind === kind,
      );
    }
    status = 200;
    reply = '{"elsewhere":true}';
    await assert.rejects(
      provision('design-3f2a91c0', 'design', signal()),
      (e: unknown) =>
        e instanceof ExecutionFailure && e.kind === 'incompatible',
    );
  } finally {
    server.close();
    await f.dispose();
  }
});

await test('a channel’s folder is a slug of its name and the start of its ID', () => {
  const id = '3f2a91c0-0000-4000-8000-000000000000';
  assert.equal(spaceDirectory('Design Review', id), 'design-review-3f2a91c0');
  assert.equal(spaceDirectory('  ——  ', id), 'channel-3f2a91c0');
  assert.equal(spaceDirectory('Café ✨ #1', id), 'cafe-1-3f2a91c0');
  assert.match(spaceDirectory('x'.repeat(80), id), /^x{40}-3f2a91c0$/);
});

await test('a message’s files are in the channel’s folder before the agent it wakes is sent to T3, and its turn says where', async () => {
  const f = await inboxFixture();
  try {
    const { provisioner } = space(f);
    const content = Buffer.from('the error log');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const file = await f.comm.upload(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key(), name: 'error.log', sha256 },
      1024 ** 3,
      {
        describe: () =>
          Promise.resolve({
            type: 'application/octet-stream',
            size: content.length,
            width: null,
            height: null,
          }),
        keep: () => Promise.resolve(),
      },
    );
    await f.comm.post(f.principal, f.teamId, f.channelId, {
      ...postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
      attachments: [file.id],
    });
    const placedAt: string[] = [];
    let launchesWhenPlaced = -1;
    const placer =
      (answer: () => Promise<void>): FilePlacer =>
      async (directory, attached, given) => {
        await answer();
        assert.deepEqual(Buffer.concat(await given.body.toArray()), content);
        assert.equal(given.size, content.length);
        assert.equal(given.sha256, sha256);
        launchesWhenPlaced = calls(f, 't3_thread_launch').length;
        const path = `/space/${directory}/attachments/${attached.id.slice(0, 8)}-error.log`;
        placedAt.push(path);
        return path;
      };
    const attemptWith = async (place: FilePlacer) => {
      await due(f.dbPath);
      const claim = await f.inbox.claim([f.agent.id]);
      assert.ok(claim);
      await deliver(
        f.store,
        claim,
        f.binding,
        f.factory,
        signal(),
        provisioner,
        {
          place,
          read: (hash) => {
            assert.equal(hash, sha256);
            return Promise.resolve(Readable.from([content]));
          },
        },
      );
      return f.inbox.get(claim.id);
    };
    // Unreachable, it waits; refused, it blocks until a person resumes it.
    const down = await attemptWith(
      placer(() => Promise.reject(new ExecutionFailure('unavailable'))),
    );
    assert.equal(down.state, 'ready');
    const refused = await attemptWith(
      placer(() => Promise.reject(new ExecutionFailure('permission'))),
    );
    assert.equal(refused.state, 'blocked');
    assert.equal(refused.reason, 'native-access');
    assert.equal(calls(f, 't3_thread_launch').length, 0);
    await f.inbox.resume(refused.id);
    f.wire.values.t3_thread_read = assistantRead('Read it');
    const done = await attemptWith(placer(() => Promise.resolve()));
    assert.equal(done.state, 'acked', done.reason);
    // Placed before the launch, and the turn names it from the folder's root.
    assert.equal(launchesWhenPlaced, 0);
    const [launch] = calls(f, 't3_thread_launch');
    assert.match(
      String(launch?.message),
      new RegExp(
        `Attached files, in your working directory:\\n- attachments/${file.id.slice(0, 8)}-error\\.log \\(application/octet-stream, 13 B\\)`,
      ),
    );
  } finally {
    await f.dispose();
  }
});
