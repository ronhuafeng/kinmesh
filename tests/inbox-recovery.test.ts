import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawDatabase } from './raw.js';
import { deliver } from '../src/inbox/worker.js';
import { FrozenLaunch } from '../src/domain/inbox.js';
import { IdentityError, type Scope } from '../src/domain/agents.js';
import { launch, options, reference } from './t3-helpers.js';
import { inboxFixture } from './inbox-helpers.js';
import { key, postInput } from './communication-helpers.js';

type Fixture = Awaited<ReturnType<typeof inboxFixture>>;
const signal = () => new AbortController().signal;
async function mention(f: Fixture) {
  await f.comm.post(
    f.principal,
    f.teamId,
    f.channelId,
    postInput({
      body: 'Ada, please check this',
      mentions: [{ kind: 'agent', id: f.agent.id }],
    }),
  );
  const claim = await f.inbox.claim([f.agent.id]);
  assert.ok(claim);
  return claim;
}
/** Deliver once after `lose` removed a precondition; return the recorded cause. */
async function causeAfter(
  lose: (f: Fixture) => Promise<void>,
  binding = (f: Fixture) => f.binding,
  factory = (f: Fixture) => f.factory,
) {
  const f = await inboxFixture();
  try {
    const claim = await mention(f);
    await lose(f);
    await deliver(f.store, claim, binding(f), factory(f), signal());
    const row = await f.inbox.get(claim.id);
    assert.equal(row.state, 'blocked', row.reason);
    return row.reason;
  } finally {
    await f.dispose();
  }
}

await test('a blocked delivery records the precondition it lost, not one catch-all reason', async () => {
  assert.equal(
    await causeAfter(async (f) => {
      await f.store.agents.revoke(
        f.principal,
        f.teamId,
        f.agent.id,
        f.inboxGrant.grant.id,
      );
    }),
    'credential-invalid',
  );
  assert.equal(
    await causeAfter(async (f) => {
      await f.store.agents.lifecycle(
        f.principal,
        f.teamId,
        f.agent.id,
        'disabled',
      );
    }),
    'agent-disabled',
  );
  assert.equal(
    await causeAfter(async (f) => {
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
    }),
    'not-in-channel',
  );
  // The worker's own setup check: its binding names another provider.
  assert.equal(
    await causeAfter(
      () => Promise.resolve(),
      (f) => ({ ...f.binding, isolatedProviderId: 'another' }),
    ),
    'native-incompatible',
  );
  // T3 now answers from another environment than the agent was connected to.
  assert.equal(
    await causeAfter(
      () => Promise.resolve(),
      undefined,
      (f) =>
        async (...args) => {
          const handle = await f.factory(...args);
          return {
            ...handle,
            identity: { ...handle.identity, environmentId: 'another' },
          };
        },
    ),
    'environment-changed',
  );
});

await test('a credential lacking a scope the delivery reads with is the cause, whatever else holds', async () => {
  for (const missing of ['channels:read', 'tasks:read'] as const) {
    const f = await inboxFixture();
    try {
      await f.create({ owner: { kind: 'agent', id: f.agent.id } });
      const claim = await f.inbox.claim([f.agent.id]);
      assert.ok(claim?.taskId);
      const lacking = await f.store.agents.issue(
        f.principal,
        f.teamId,
        f.agent.id,
        {
          label: 'Lacks ' + missing,
          scopes: (
            [
              'channels:read',
              'channels:write',
              'tasks:read',
              'tasks:write',
              'executions:read',
              'executions:write',
            ] satisfies Scope[]
          ).filter((scope) => scope !== missing),
          lifetimeSeconds: 3600,
        },
      );
      assert.equal(
        await f.inbox.blockedCause(claim, () => lacking.token),
        'credential-invalid',
        missing,
      );
    } finally {
      await f.dispose();
    }
  }
});

await test('an owner resumes a blocked delivery over HTTP with every resume invariant kept', async () => {
  const f = await inboxFixture();
  try {
    const claim = await mention(f);
    const resume = (id: string, operationKey: string, headers = {}) =>
      f.app.inject({
        method: 'POST',
        url: `/api/teams/${f.teamId}/deliveries/${id}/resume`,
        ...(Object.keys(headers).length ? { headers } : { cookies: f.cookies }),
        payload: { operationKey },
      });
    // Not blocked yet: nothing to resume.
    assert.equal((await resume(claim.id, key())).statusCode, 409);
    await f.inbox.defer(claim, 'blocked', 'credential-invalid');
    // Agents never reach owner recovery, even with every scope.
    const agent = await resume(claim.id, key(), {
      authorization: 'Bearer ' + f.inboxGrant.token,
    });
    assert.equal(agent.statusCode, 403);
    assert.equal((await f.inbox.get(claim.id)).state, 'blocked');
    assert.equal((await resume(randomUUID(), key())).statusCode, 404);
    const operation = key();
    const first = await resume(claim.id, operation);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(
      z.object({ id: z.uuid() }).parse(first.json<unknown>()).id,
      claim.id,
    );
    const row = await f.inbox.get(claim.id);
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
    const claim = await mention(f);
    await f.inbox.defer(claim, 'blocked', 'not-in-channel');
    await f.comm.membership(
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
    assert.equal((await f.inbox.get(claim.id)).state, 'blocked');
  } finally {
    await f.dispose();
  }
});

await test('resume cannot bypass a revoked credential, and only a task taken away reports lost assignment', async () => {
  const f = await inboxFixture();
  try {
    const claim = await mention(f);
    await f.store.agents.revoke(
      f.principal,
      f.teamId,
      f.agent.id,
      f.inboxGrant.grant.id,
    );
    await deliver(f.store, claim, f.binding, f.factory, signal());
    await f.inbox.resume(claim.id);
    const again = await f.inbox.claim([f.agent.id]);
    assert.equal(again?.id, claim.id);
    await deliver(f.store, again, f.binding, f.factory, signal());
    const row = await f.inbox.get(claim.id);
    assert.equal(row.state, 'blocked');
    assert.equal(row.reason, 'credential-invalid');
    assert.equal(row.operationId, null);
  } finally {
    await f.dispose();
  }
  const g = await inboxFixture();
  try {
    const { task } = await g.create({
      owner: { kind: 'agent', id: g.agent.id },
    });
    const claim = await g.inbox.claim([g.agent.id]);
    assert.ok(claim?.taskId);
    // Still the task's owner: whatever blocked it, assignment did not.
    assert.equal(
      await g.inbox.blockedCause(claim, () => g.inboxGrant.token),
      'authority-or-contract-blocked',
    );
    await g.act(g.principal, task, { type: 'cancel', note: 'Not needed' });
    assert.equal(
      await g.inbox.blockedCause(claim, () => g.inboxGrant.token),
      'not-assigned',
    );
  } finally {
    await g.dispose();
  }
});

await test('a request that never reached T3 is retried under a reconnected T3; one that may have reached it is not', async () => {
  const f = await inboxFixture();
  try {
    const claim = await mention(f);
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
    await f.inbox.freeze(claim, f.workerPrincipal, frozen('read-only'));
    const refrozen = await f.inbox.freeze(
      claim,
      f.workerPrincipal,
      frozen('supervised'),
    );
    assert.equal(refrozen.execution.authority, 'supervised');
    assert.equal((await f.inbox.get(claim.id)).reason, 'launch-refrozen');
    // Once an operation may exist natively, the authority is pinned for good.
    await f.inbox.remember(claim, { operationId: 'native-operation' });
    await assert.rejects(
      () => f.inbox.freeze(claim, f.workerPrincipal, frozen('another')),
      (error: unknown) =>
        error instanceof IdentityError && error.statusCode === 403,
    );
    // The database refuses it too, whatever code tries.
    const raw = rawDatabase(f.dbPath);
    try {
      await assert.rejects(
        () =>
          raw
            .prepare('UPDATE agent_inbox SET launch = ? WHERE id = ?')
            .run(JSON.stringify(frozen('another')), claim.id),
        /immutable inbox contract/,
      );
    } finally {
      await raw.close();
    }
  } finally {
    await f.dispose();
  }
});
