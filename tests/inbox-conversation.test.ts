import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { deliver } from '../src/inbox/worker.js';
import { assistantRead, due, inboxFixture } from './inbox-helpers.js';
import { key, postInput } from './communication-helpers.js';
import { envelope, launched } from './t3-helpers.js';
import { MessageId, type TopicId } from '../src/domain/communication.js';
import { rawDatabase } from './raw.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
/** A model T3 also offers, besides the one the agent started with. */
const OTHER_MODEL = 'fixture-id-4';
const signal = () => new AbortController().signal;
const Args = z.record(z.string(), z.unknown());
/** The run T3 reports for the thread's first message. */
const RUN = z.string().parse(launched.runId);

async function mention(f: Fixture, topicId: TopicId | null = null) {
  await f.comm.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({ topicId, mentions: [{ kind: 'agent', id: f.agent.id }] }),
  );
}
/** One worker attempt at whatever is due for the agent. */
async function attempt(f: Fixture) {
  await due(f.dbPath);
  const claim = await f.inbox.claim([f.agent.id]);
  assert.ok(claim);
  await deliver(f.store, claim, f.binding, f.factory, signal());
  return f.inbox.get(claim.id);
}
const calls = (f: Fixture, name: string) =>
  f.wire.calls.filter((c) => c.name === name).map((c) => Args.parse(c.args));
/** T3's view of the thread: its runs, newest first, and their answers. */
function thread(
  runs: { runId: string; status: string; text?: string; position: number }[],
) {
  const base = assistantRead();
  const [template] = base.items;
  const [latest] = runs;
  const [run] = base.recentRuns;
  assert.ok(template && latest && run);
  const busy = ['running', 'waiting'].includes(latest.status);
  return {
    ...base,
    thread: {
      ...base.thread,
      status: latest.status,
      activeRunId: busy ? latest.runId : null,
      latestRunId: latest.runId,
      pendingRequestCount: latest.status === 'waiting' ? 1 : 0,
    },
    recentRuns: runs.map((r) => ({ ...run, runId: r.runId, status: r.status })),
    items: runs.flatMap((r) =>
      r.text === undefined
        ? []
        : [{ ...template, runId: r.runId, text: r.text, position: r.position }],
    ),
  };
}
function sendReturns(f: Fixture, runId: string, delivery: string) {
  f.wire.values.t3_thread_send = {
    threadId: launched.threadId,
    messageId: 'fixture-sent-message',
    runId,
    status: 'running',
    delivery,
  };
}

await test('an agent keeps one T3 conversation per channel: later messages continue its thread', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = thread([
      {
        runId: RUN,
        status: 'completed',
        text: 'First',
        position: 2,
      },
    ]);
    const first = await attempt(f);
    assert.equal(first.state, 'acked', first.reason);

    await mention(f);
    sendReturns(f, 'second-run', 'started');
    f.wire.values.t3_thread_read = thread([
      { runId: 'second-run', status: 'completed', text: 'Second', position: 6 },
      {
        runId: RUN,
        status: 'completed',
        text: 'First',
        position: 2,
      },
    ]);
    const second = await attempt(f);
    assert.equal(second.state, 'acked', second.reason);
    assert.notEqual(second.resultMessageId, first.resultMessageId);

    // One thread: the first message started it, the second continued it.
    const [launch] = calls(f, 't3_thread_launch');
    assert.equal(calls(f, 't3_thread_launch').length, 1);
    assert.match(
      String(launch?.message),
      /^You are .+, an agent in the Kinmesh channel #/,
    );
    const sends = calls(f, 't3_thread_send');
    assert.equal(sends.length, 1);
    const [sent] = sends;
    assert.ok(sent);
    assert.equal(sent.threadId, launched.threadId);
    assert.equal(sent.mode, 'auto');
    assert.match(String(sent.message), /^<message from="[^"]+">\n/);
    // Its run is read after the answer already published, not from the start.
    const reads = calls(f, 't3_thread_read');
    assert.equal(reads.at(-1)?.afterPosition, 2);
    const reply = await f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      MessageId.parse(second.resultMessageId),
    );
    assert.equal(reply.body, 'Second');
  } finally {
    await f.dispose();
  }
});

await test('a run waiting for approval holds no message back: the next steers it, and its reply answers both once', async () => {
  const f = await inboxFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await mention(f);
    f.wire.values.t3_thread_read = thread([
      { runId: RUN, status: 'waiting', position: 0 },
    ]);
    const first = await attempt(f);
    assert.equal(first.state, 'waiting', first.reason);

    // The next message is claimed at once, while the first still waits.
    await mention(f);
    const next = await f.inbox.claim([f.agent.id]);
    assert.ok(next);
    assert.notEqual(next.id, first.id);
    sendReturns(f, RUN, 'steered');
    await deliver(f.store, next, f.binding, f.factory, signal());
    assert.equal(calls(f, 't3_thread_send')[0]?.mode, 'auto');
    const steered = await f.inbox.get(next.id);
    assert.equal(steered.reference, first.reference);

    // The approval is given; the run's one reply answers both messages.
    f.wire.values.t3_thread_read = thread([
      { runId: RUN, status: 'completed', text: 'Both', position: 4 },
    ]);
    const a = await attempt(f);
    const b = await attempt(f);
    assert.equal(a.state, 'acked', a.reason);
    assert.equal(b.state, 'acked', b.reason);
    assert.ok(a.resultMessageId);
    assert.equal(a.resultMessageId, b.resultMessageId);
    assert.equal(
      await raw.prepare('SELECT count(*) FROM inbox_results').pluck().get(),
      1,
    );
    const replies = (
      await f.comm.history(f.principal, f.teamId, f.channelId)
    ).items.filter((m) => m.author.kind === 'agent');
    assert.equal(replies.length, 1);
  } finally {
    await raw.close();
    await f.dispose();
  }
});

await test('another model starts a new conversation', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = assistantRead('On the first model');
    assert.equal((await attempt(f)).state, 'acked');

    const profile = await f.store.agents.get(f.principal, f.teamId, f.agent.id);
    await f.store.agents.update(f.principal, f.teamId, f.agent.id, {
      name: profile.name,
      role: profile.role,
      capabilities: profile.capabilities,
      memoryLocation: profile.memoryLocation,
      preferences: { ...profile.preferences, modelId: OTHER_MODEL },
    });
    await mention(f);
    // T3 launches and reports the run on the model it was asked for.
    const started = z
      .object({ modelSelection: z.record(z.string(), z.unknown()) })
      .loose()
      .parse(f.wire.values.t3_thread_launch);
    f.wire.values.t3_thread_launch = {
      ...started,
      modelSelection: { ...started.modelSelection, model: OTHER_MODEL },
    };
    const read = assistantRead('On the new model');
    f.wire.values.t3_thread_read = {
      ...read,
      thread: { ...read.thread, model: OTHER_MODEL },
      recentRuns: read.recentRuns.map((run) => ({
        ...run,
        model: OTHER_MODEL,
      })),
    };
    const second = await attempt(f);
    assert.equal(second.state, 'acked', second.reason);
    assert.equal(calls(f, 't3_thread_launch').length, 2);
    assert.equal(calls(f, 't3_thread_send').length, 0);
    assert.match(
      String(calls(f, 't3_thread_launch')[1]?.message),
      /^You are .+, an agent in the Kinmesh channel #/,
    );
  } finally {
    await f.dispose();
  }
});

await test('each topic is its own conversation; the channel outside topics is another', async () => {
  const f = await inboxFixture();
  try {
    const topic = (title: string) =>
      f.comm.createTopic(f.principal, f.teamId, f.channelId, {
        operationKey: key(),
        title,
      });
    const logo = await topic('Logo');
    const site = await topic('Site');
    f.wire.values.t3_thread_read = assistantRead('Answered');
    for (const where of [null, logo.id, site.id]) {
      await mention(f, where);
      assert.equal((await attempt(f)).state, 'acked');
    }
    // A thread each: outside topics, then one per topic.
    const launches = calls(f, 't3_thread_launch');
    assert.equal(launches.length, 3);
    assert.match(String(launches[1]?.title), / \/ Logo$/);
    assert.match(String(launches[1]?.message), /in its topic "Logo"/);
    assert.equal(calls(f, 't3_thread_send').length, 0);

    // The next message in a topic continues that topic's thread.
    await mention(f, logo.id);
    assert.equal((await attempt(f)).state, 'acked');
    assert.equal(calls(f, 't3_thread_launch').length, 3);
    assert.equal(calls(f, 't3_thread_send').length, 1);
  } finally {
    await f.dispose();
  }
});

/** T3 after someone deleted the first thread: it answers only for a new one. */
function deleteFirstThread(f: Fixture) {
  const NEW_THREAD = 'fixture-new-thread';
  const gone = {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          _tag: 'OrchestratorMcpFailure',
          code: 'thread_not_found',
          message: 'Thread is no longer available.',
        }),
      },
    ],
  };
  f.wire.handler = (name, args) => {
    if (name !== 't3_thread_launch' && args.threadId === launched.threadId)
      return Promise.resolve(gone);
    const value = Args.parse(f.wire.values[name]);
    const thread = Args.parse(value.thread ?? {});
    return Promise.resolve(
      envelope(
        name === 't3_thread_read'
          ? { ...value, thread: { ...thread, threadId: NEW_THREAD } }
          : { ...value, threadId: NEW_THREAD },
      ),
    );
  };
  return NEW_THREAD;
}

await test('a thread deleted in T3 ends its conversation: the next message starts a new one', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = assistantRead('First');
    assert.equal((await attempt(f)).state, 'acked');

    const newThread = deleteFirstThread(f);
    f.wire.values.t3_thread_read = assistantRead('In a new thread');
    await mention(f);
    const second = await attempt(f);
    assert.equal(second.state, 'acked', second.reason);
    // T3 refused the send to the deleted thread; the message started a new
    // thread, with the rules a first turn carries.
    assert.equal(calls(f, 't3_thread_send').length, 1);
    const launches = calls(f, 't3_thread_launch');
    assert.equal(launches.length, 2);
    assert.match(
      String(launches[1]?.message),
      /^You are .+, an agent in the Kinmesh channel #/,
    );
    const reply = await f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      MessageId.parse(second.resultMessageId),
    );
    assert.equal(reply.body, 'In a new thread');

    // The conversation continues in the new thread.
    await mention(f);
    assert.equal((await attempt(f)).state, 'acked');
    assert.equal(calls(f, 't3_thread_launch').length, 2);
    assert.equal(calls(f, 't3_thread_send').at(-1)?.threadId, newThread);
  } finally {
    await f.dispose();
  }
});

await test('a run whose thread is deleted in T3 ends with a stopped notice', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = thread([
      { runId: RUN, status: 'waiting', position: 0 },
    ]);
    assert.equal((await attempt(f)).state, 'waiting');

    deleteFirstThread(f);
    const ended = await attempt(f);
    assert.equal(ended.state, 'acked', ended.reason);
    assert.equal(ended.reason, 'native-terminal-notice-published');
  } finally {
    await f.dispose();
  }
});

await test('a reply whose T3 item id is long, as pi’s are, is published', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    const read = assistantRead('From pi');
    const [item] = read.items;
    assert.ok(item);
    f.wire.values.t3_thread_read = {
      ...read,
      items: [{ ...item, itemId: 'turn-item:provider:pi:' + 'x'.repeat(600) }],
    };
    const delivery = await attempt(f);
    assert.equal(delivery.state, 'acked', delivery.reason);
    const reply = await f.comm.message(
      f.principal,
      f.teamId,
      f.channelId,
      MessageId.parse(delivery.resultMessageId),
    );
    assert.equal(reply.body, 'From pi');
  } finally {
    await f.dispose();
  }
});

await test('a reply T3 returns outside Kinmesh’s contract blocks with its cause, not retried', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    const read = assistantRead('Too long to name');
    const [item] = read.items;
    assert.ok(item);
    f.wire.values.t3_thread_read = {
      ...read,
      items: [{ ...item, itemId: 'x'.repeat(4096) }],
    };
    const delivery = await attempt(f);
    assert.equal(delivery.state, 'blocked', delivery.reason);
    assert.equal(delivery.reason, 'native-unreadable');
    // Nothing picks it up again on its own, and the run was launched once.
    await due(f.dbPath);
    assert.equal(await f.inbox.claim([f.agent.id]), undefined);
    assert.equal(calls(f, 't3_thread_launch').length, 1);
  } finally {
    await f.dispose();
  }
});

await test('a launch whose answer can’t be read blocks; its retry reconciles under the same request key', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_launch = { threadId: 42 };
    const delivery = await attempt(f);
    assert.equal(delivery.state, 'blocked', delivery.reason);
    assert.equal(delivery.reason, 'native-unreadable');
    await due(f.dbPath);
    assert.equal(await f.inbox.claim([f.agent.id]), undefined);

    // Once T3's answer reads again, the retry finds the same launch.
    f.wire.values.t3_thread_launch = launched;
    f.wire.values.t3_thread_read = assistantRead('Read at last');
    await f.inbox.resume(delivery.id);
    const resumed = await attempt(f);
    assert.equal(resumed.state, 'acked', resumed.reason);
    const keys = calls(f, 't3_thread_launch').map((c) => c.clientRequestId);
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, 1);
  } finally {
    await f.dispose();
  }
});
