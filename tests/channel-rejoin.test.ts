import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Principal } from '../src/domain/agents.js';
import { key } from './communication-helpers.js';
import { taskFixture } from './task-helpers.js';

await test('only channels the caller left are offered for rejoining; removed and other members’ channels never are', async () => {
  const f = await taskFixture();
  try {
    const grant = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
      label: 'Rejoin test',
      scopes: ['channels:read', 'channels:write'],
      lifetimeSeconds: 600,
    });
    const agent = f.store.agents.resolveToken(grant.token);
    const ids = (p: Principal) =>
      f.comm.leftChannels(p, f.teamId).map((c) => c.id);
    assert.deepEqual(ids(f.principal), []);
    // The owner leaves; the channel is offered back, and the API agrees.
    f.comm.membership(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    assert.deepEqual(ids(f.principal), [f.channelId]);
    const listed = await f.app.inject({
      url: `/api/teams/${f.teamId}/channels?membership=left`,
      cookies: f.cookies,
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      z
        .object({ items: z.array(z.object({ id: z.string() }).loose()) })
        .parse(listed.json<unknown>())
        .items.map((c) => c.id),
      [f.channelId],
    );
    // An agent that never left sees nothing; leaving is per member.
    assert.deepEqual(ids(agent), []);
    f.comm.membership(
      f.principal,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'subscribe',
    );
    assert.deepEqual(ids(f.principal), []);
    // Removal by the owner is final: it is never offered back.
    const other = f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'removal',
    });
    for (const action of ['invite', 'remove'] as const)
      f.comm.enroll(
        f.principal,
        f.teamId,
        other.id,
        { operationKey: key(), member: { kind: 'agent', id: f.agent.id } },
        action,
      );
    f.comm.membership(
      agent,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    assert.deepEqual(ids(agent), [f.channelId]);
  } finally {
    await f.dispose();
  }
});
