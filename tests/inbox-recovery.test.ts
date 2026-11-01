import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { deliver } from '../src/inbox/worker.js';
import { FrozenLaunch } from '../src/domain/inbox.js';
import { IdentityError } from '../src/domain/agents.js';
import { launch, options, reference } from './t3-helpers.js';
import { inboxFixture } from './inbox-helpers.js';
import { key, postInput } from './communication-helpers.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
const signal = () => new AbortController().signal;
function mention(f: Fixture) {
  f.comm.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({
      body: 'Ada, please check this',
      mentions: [{ kind: 'agent', id: f.agent.id }],
    }),
  );
  const claim = f.inbox.claim([f.agent.id]);
  assert.ok(claim);
  return claim;
}
/** Deliver once after `lose` removed a precondition; return the recorded cause. */
async function causeAfter(
  lose: (f: Fixture) => void,
  binding = (f: Fixture) => f.binding,
) {
  const f = await inboxFixture();
  try {
    const claim = mention(f);
    lose(f);
    await deliver(f.store, claim, binding(f), f.factory, signal());
    const row = f.inbox.get(claim.id);
    assert.equal(row.state, 'blocked', row.reason);
    return row.reason;
  } finally {
    await f.dispose();
  }
}

await test('a blocked delivery records the precondition it lost, not one catch-all reason', async () => {
  assert.equal(
    await causeAfter((f) => {
      f.store.agents.revoke(
        f.principal,
        f.teamId,
        f.agent.id,
        f.inboxGrant.grant.id,
      );
    }),
    'credential-invalid',
  );
  assert.equal(
    await causeAfter((f) => {
      f.store.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'disabled');
    }),
    'agent-disabled',
  );
  assert.equal(
    await causeAfter((f) => {
      f.comm.enroll(
        f.principal,
        f.teamId,
        f.channelId,
        { operationKey: key(), member: { kind: 'agent', id: f.agent.id } },
        'remove',
      );
    }),
    'not-in-channel',
  );
  // The worker's own setup check: its binding names another provider.
  assert.equal(
    await causeAfter(
      () => undefined,
      (f) => ({ ...f.binding, isolatedProviderId: 'another' }),
    ),
    'native-incompatible',
  );
});

await test('an owner resumes a blocked delivery over HTTP with every resume invariant kept', async () => {
  const f = await inboxFixture();
  try {
    const claim = mention(f);
    const resume = (id: string, operationKey: string, headers = {}) =>
      f.app.inject({
        method: 'POST',
        url: `/api/teams/${f.teamId}/deliveries/${id}/resume`,
        ...(Object.keys(headers).length ? { headers } : { cookies: f.cookies }),
        payload: { operationKey },
      });
    // Not blocked yet: nothing to resume.
    assert.equal((await resume(claim.id, key())).statusCode, 409);
    f.inbox.defer(claim, 'blocked', 'credential-invalid');
    // Agents never reach owner recovery, even with every scope.
    const agent = await resume(claim.id, key(), {
      authorization: 'Bearer ' + f.inboxGrant.token,
    });
    assert.equal(agent.statusCode, 403);
    assert.equal(f.inbox.get(claim.id).state, 'blocked');
    assert.equal((await resume(randomUUID(), key())).statusCode, 404);
    const operation = key();
    const first = await resume(claim.id, operation);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(
      z.object({ id: z.uuid() }).parse(first.json<unknown>()).id,
      claim.id,
    );
    const row = f.inbox.get(claim.id);
    // Never dispatched: it re-enters as uncertain with its frozen intent.
    assert.equal(row.state, 'uncertain');
    assert.equal(row.reason, 'owner-resume');
    // A lost response is retried with the same key and replays.
    assert.equal((await resume(claim.id, operation)).statusCode, 200);
    // A second, different resume finds nothing blocked.
    assert.equal((await resume(claim.id, key())).statusCode, 409);
  } finally {
    await f.dispose();
  }
});

await test('owner resume needs access to the delivery’s channel', async () => {
  const f = await inboxFixture();
  try {
    const claim = mention(f);
    f.inbox.defer(claim, 'blocked', 'not-in-channel');
    f.comm.membership(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    const denied = await f.app.inject({
      method: 'POST',
      url: `/api/teams/${f.teamId}/deliveries/${claim.id}/resume`,
      cookies: f.cookies,
      payload: { operationKey: key() },
    });
    assert.notEqual(denied.statusCode, 200);
    assert.equal(f.inbox.get(claim.id).state, 'blocked');
  } finally {
    await f.dispose();
  }
});

await test('resume cannot bypass a revoked credential, and task work reports lost assignment', async () => {
  const f = await inboxFixture();
  try {
    const claim = mention(f);
    f.store.agents.revoke(
      f.principal,
      f.teamId,
      f.agent.id,
      f.inboxGrant.grant.id,
    );
    await deliver(f.store, claim, f.binding, f.factory, signal());
    f.inbox.resume(claim.id);
    const again = f.inbox.claim([f.agent.id]);
    assert.equal(again?.id, claim.id);
    await deliver(f.store, again, f.binding, f.factory, signal());
    const row = f.inbox.get(claim.id);
    assert.equal(row.state, 'blocked');
    assert.equal(row.reason, 'credential-invalid');
    assert.equal(row.operationId, null);
  } finally {
    await f.dispose();
  }
  const g = await inboxFixture();
  try {
    g.create({ owner: { kind: 'agent', id: g.agent.id } });
    const claim = g.inbox.claim([g.agent.id]);
    assert.ok(claim?.taskId);
    assert.equal(
      g.inbox.blockedCause(claim, () => g.inboxGrant.token),
      'not-assigned',
    );
  } finally {
    await g.dispose();
  }
});

await test('a request that never reached T3 is retried under a reconnected T3; one that may have reached it is not', async () => {
  const f = await inboxFixture();
  try {
    const claim = mention(f);
    const worker = f.workerPrincipal;
    if (worker.kind !== 'agent') throw new Error('Agent principal expected');
    const frozen = (authority: string) =>
      FrozenLaunch.parse({
        grantId: worker.grantId,
        execution: {
          endpoint: options.endpoint,
          environmentId: reference.environmentId,
          authority,
        },
        input: launch,
      });
    // Frozen under a read-only grant that T3 then refused before any dispatch.
    f.inbox.freeze(claim, f.workerPrincipal, frozen('read-only'));
    const refrozen = f.inbox.freeze(
      claim,
      f.workerPrincipal,
      frozen('supervised'),
    );
    assert.equal(refrozen.execution.authority, 'supervised');
    assert.equal(f.inbox.get(claim.id).reason, 'launch-refrozen');
    // Once an operation may exist natively, the authority is pinned for good.
    f.inbox.remember(claim, { operationId: 'native-operation' });
    assert.throws(
      () => f.inbox.freeze(claim, f.workerPrincipal, frozen('another')),
      (error: unknown) =>
        error instanceof IdentityError && error.statusCode === 403,
    );
    // The database refuses it too, whatever code tries.
    const raw = new Database(f.dbPath);
    try {
      assert.throws(
        () =>
          raw
            .prepare('UPDATE agent_inbox SET launch = ? WHERE id = ?')
            .run(JSON.stringify(frozen('another')), claim.id),
        /immutable inbox contract/,
      );
    } finally {
      raw.close();
    }
  } finally {
    await f.dispose();
  }
});
