import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver } from '../src/inbox/worker.js';
import { inboxFixture } from './inbox-helpers.js';
import { postInput } from './communication-helpers.js';
import { mockRead } from './t3-helpers.js';
import { connectTeam, startTeam, stop } from './team-mcp-helpers.js';
import { freePort } from './process-helpers.js';

/**
 * Proves a run waiting for an approval in T3 stops saying so as soon as its
 * agent acts in Kinmesh: an agent's request to Team MCP means no run of its
 * waits on a person, so its delivery is looked at now instead of at the
 * next of its slowing looks (up to 15 seconds), and the waiting line goes.
 * Nothing it shows changes before the worker has looked.
 */
await test('an agent acting through Team MCP has its approval wait looked at now, and the waiting line goes', async () => {
  const f = await inboxFixture();
  const port = await freePort();
  const team = await startTeam(f.dbPath, port, f.filesEnv);
  const { client } = await connectTeam(
    `http://127.0.0.1:${String(port)}/mcp`,
    f.inboxGrant.token,
  );
  /** One worker attempt at the agent's delivery, when it is due. */
  const attempt = async () => {
    const claim = await f.inbox.claim([f.agent.id]);
    assert.ok(claim, 'the delivery is due');
    await deliver(
      f.store,
      claim,
      f.binding,
      f.factory,
      new AbortController().signal,
    );
    return f.inbox.get(claim.id);
  };
  try {
    await f.store.messages.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ mentions: [{ kind: 'agent', id: f.agent.id }] }),
    );
    // Its run waits for a person's approval in T3.
    f.wire.values.t3_thread_read = { ...mockRead('waiting'), items: [] };
    const waiting = await attempt();
    assert.equal(waiting.reason, 'human-or-approval-wait');
    assert.ok(waiting.nextAttempt > Date.now(), 'looked at again later');
    assert.equal(await f.inbox.claim([f.agent.id]), null);

    // The person approved; the agent goes on and asks Kinmesh something.
    f.wire.values.t3_thread_read = { ...mockRead('running'), items: [] };
    await client.callTool({ name: 'team_channels_list', arguments: {} });
    const nudged = await f.inbox.get(waiting.id);
    assert.ok(nudged.nextAttempt <= Date.now(), 'due now');
    assert.equal(
      nudged.reason,
      'human-or-approval-wait',
      'unchanged until looked at',
    );

    // The worker looks at once, and the line no longer says it waits.
    const looked = await attempt();
    assert.equal(looked.state, 'waiting');
    assert.equal(looked.reason, 'execution-active');
  } finally {
    await client.close();
    await stop(team);
    await f.dispose();
  }
});
