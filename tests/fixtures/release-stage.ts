// Credential-free process substitute for the three native scripts. Never contacts T3.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LiveContext } from '../../src/team-mcp/live-context.js';
import { openStore } from '../../src/persistence/store.js';
import { loadAgentToken } from '../../src/team-mcp/client.js';

assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.KINMESH_SHARED_SECRET, undefined);
assert.equal(process.env.KINMESH_T3_PROVIDER_HOME, undefined);
const directory = process.env.HOME;
assert.ok(directory);
const scenario = process.env.FIXTURE_STAGE;
if (scenario === 'sdk') {
  assert.equal(process.env.KINMESH_TEAM_LIVE_DIR, undefined);
  assert.equal(process.env.KINMESH_INBOX_CONFIG, undefined);
  assert.equal(
    process.env.KINMESH_T3_LIVE_DATABASE,
    join(directory, 'sdk.sqlite'),
  );
} else {
  assert.equal(process.env.KINMESH_TEAM_LIVE_DIR, directory);
  const c = LiveContext.parse(
    JSON.parse(readFileSync(join(directory, 'context.json'), 'utf8')),
  );
  const store = openStore(c.database);
  try {
    const p = store.agents.resolveToken(loadAgentToken(c.tokenFile));
    let task = store.tasks.get(p, c.teamId, c.channelId, c.taskId);
    assert.equal(task.state.status, 'proposed');
    assert.equal(task.version, 1);
    if (scenario === 'team') {
      assert.equal(process.env.KINMESH_INBOX_CONFIG, undefined);
      task = store.tasks.command(p, c.teamId, c.channelId, c.taskId, {
        type: 'claim',
        expectedVersion: 1,
        operationKey: randomUUID(),
      }).task;
      task = store.tasks.command(p, c.teamId, c.channelId, c.taskId, {
        type: 'handoff',
        expectedVersion: 2,
        operationKey: randomUUID(),
        mode: 'review',
        recipient: { kind: 'agent', id: c.reviewerId },
        note: 'Fixture only; no provider',
      }).task;
      assert.equal(task.state.status, 'review-requested');
      assert.equal(task.version, 3);
    } else {
      assert.equal(scenario, 'inbox');
      assert.equal(
        process.env.KINMESH_INBOX_CONFIG,
        join(directory, 'inbox.json'),
      );
      assert.equal(process.env.KINMESH_TEAM_T3_ISOLATED_PROVIDER, undefined);
      assert.equal(process.env.KINMESH_T3_AUTH_FILE, undefined);
    }
  } finally {
    store.close();
  }
}
writeFileSync(join(directory, 'fixture-stage-passed'), scenario, {
  mode: 0o600,
});
