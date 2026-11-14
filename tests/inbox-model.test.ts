import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { deliver } from '../src/inbox/worker.js';
import { FrozenLaunch } from '../src/domain/inbox.js';
import { assistantRead, due, inboxFixture } from './inbox-helpers.js';
import { postInput } from './communication-helpers.js';
import { launch, options, reference } from './t3-helpers.js';
import { z } from 'zod';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
/** A model T3 also offers, besides the one the agent started with. */
const OTHER_MODEL = 'fixture-id-4';
const signal = () => new AbortController().signal;

async function mention(f: Fixture) {
  await f.comm.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
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
/** What someone chose for the agent on its page: another model, same provider. */
async function chooseModel(f: Fixture, modelId: string) {
  const profile = await f.store.agents.get(f.principal, f.teamId, f.agent.id);
  await f.store.agents.update(f.principal, f.teamId, f.agent.id, {
    name: profile.name,
    role: profile.role,
    capabilities: profile.capabilities,
    memoryLocation: profile.memoryLocation,
    preferences: { ...profile.preferences, modelId },
  });
}
const launches = (f: Fixture) =>
  f.wire.calls.filter((c) => c.name === 't3_thread_launch');

await test('a model chosen while a run is in T3 leaves that run to post its answer', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = assistantRead('Still working', 'waiting');
    const waiting = await attempt(f);
    assert.equal(waiting.state, 'waiting');
    assert.ok(waiting.reference);
    await chooseModel(f, OTHER_MODEL);
    f.wire.values.t3_thread_read = assistantRead('The answer it owed');
    const done = await attempt(f);
    assert.equal(done.state, 'acked', done.reason);
    assert.ok(done.resultMessageId);
    // It ran, and finished, on the model it started with.
    assert.equal(launches(f).length, 1);
    assert.equal(
      FrozenLaunch.parse(JSON.parse(done.launch ?? '')).input.model.modelId,
      launch.model.modelId,
    );
  } finally {
    await f.dispose();
  }
});

await test('a model chosen before a run reaches T3 is the one it launches with', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    // Frozen with the first model, then refused before anything reached T3.
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim);
    const principal = await f.store.agents.resolveToken(f.inboxGrant.token);
    assert.ok(principal.kind === 'agent');
    // The same T3 and credential the worker uses: only the model differs.
    await f.inbox.freeze(
      claim,
      principal,
      FrozenLaunch.parse({
        grantId: principal.grantId,
        execution: {
          endpoint: options.endpoint,
          environmentId: reference.environmentId,
          authority: options.authority,
        },
        input: launch,
      }),
    );
    await f.inbox.defer(claim, 'ready', 'temporarily-unavailable');
    await chooseModel(f, OTHER_MODEL);
    // T3 launches and reports the run on the model it was asked for.
    const started = z
      .object({ modelSelection: z.record(z.string(), z.unknown()) })
      .loose()
      .parse(f.wire.values.t3_thread_launch);
    f.wire.values.t3_thread_launch = {
      ...started,
      modelSelection: { ...started.modelSelection, model: OTHER_MODEL },
    };
    const read = assistantRead();
    f.wire.values.t3_thread_read = {
      ...read,
      thread: { ...read.thread, model: OTHER_MODEL },
      recentRuns: read.recentRuns.map((run) => ({
        ...run,
        model: OTHER_MODEL,
      })),
    };
    const done = await attempt(f);
    assert.equal(done.state, 'acked', done.reason);
    const [sent] = launches(f);
    assert.ok(sent);
    assert.equal(
      z
        .object({ modelSelection: z.object({ model: z.string() }) })
        .parse(sent.args).modelSelection.model,
      OTHER_MODEL,
    );
  } finally {
    await f.dispose();
  }
});

await test('a new provider waits for the worker to serve it, instead of blocking', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    const profile = await f.store.agents.get(f.principal, f.teamId, f.agent.id);
    await f.store.agents.update(f.principal, f.teamId, f.agent.id, {
      name: profile.name,
      role: profile.role,
      capabilities: profile.capabilities,
      memoryLocation: profile.memoryLocation,
      preferences: { ...profile.preferences, providerId: 'another' },
    });
    const row = await attempt(f);
    assert.equal(row.state, 'ready');
    assert.equal(row.reason, 'setup-catching-up');
    assert.equal(launches(f).length, 0);
  } finally {
    await f.dispose();
  }
});

await test('a run started under a credential the agent no longer has cannot post, and says why', async () => {
  const f = await inboxFixture();
  try {
    await mention(f);
    f.wire.values.t3_thread_read = assistantRead('Still working', 'waiting');
    const waiting = await attempt(f);
    assert.ok(waiting.reference);
    // Reconnected: the old credential revoked, a new one in its place.
    await f.store.agents.revoke(
      f.principal,
      f.teamId,
      f.agent.id,
      f.inboxGrant.grant.id,
    );
    const fresh = await f.store.agents.issue(
      f.principal,
      f.teamId,
      f.agent.id,
      {
        label: 'Reconnected worker',
        scopes: f.inboxGrant.grant.scopes,
        lifetimeSeconds: 3600,
      },
    );
    writeFileSync(f.binding.tokenFile, JSON.stringify({ token: fresh.token }), {
      mode: 0o600,
    });
    f.wire.values.t3_thread_read = assistantRead('An answer it may not post');
    const row = await attempt(f);
    assert.equal(row.state, 'blocked');
    assert.equal(row.reason, 'authority-changed');
    assert.equal(row.resultMessageId, null);
  } finally {
    await f.dispose();
  }
});
