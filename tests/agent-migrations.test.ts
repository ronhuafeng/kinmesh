import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { migrateTo } from './migration-helpers.js';
import { HumanId, TeamId } from '../src/domain/contracts.js';
import { fixture } from './helpers.js';
import { profileInput, grantInput, correlationInput } from './agent-helpers.js';

await test('upgrade from populated foundation/adapter migrations preserves owner, operation journal and new agent state across reopen', () => {
  const f = fixture();
  const humanId = HumanId.parse(randomUUID());
  const teamId = TeamId.parse(randomUUID());
  const operationId = randomUUID();
  const raw = new Database(f.path);
  raw.pragma('foreign_keys = ON');
  raw.pragma('journal_mode = WAL');
  try {
    migrateTo(raw, f.directory, 2);
    raw
      .prepare('INSERT INTO humans VALUES (?, ?, ?)')
      .run(humanId, 'old-owner', 'migration-test-only-hash');
    raw.prepare('INSERT INTO teams VALUES (?, ?)').run(teamId, 'Existing team');
    raw
      .prepare('INSERT INTO memberships VALUES (?, ?, ?)')
      .run(humanId, teamId, 'owner');
    raw
      .prepare('INSERT INTO bootstrap VALUES (1, ?)')
      .run(new Date().toISOString());
    raw
      .prepare(
        'INSERT INTO execution_operations (id, scope, actor, operation_key, request_id, fingerprint, tool, payload, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        operationId,
        'old-scope',
        humanId,
        'old-operation',
        randomUUID(),
        'old-fingerprint',
        't3_thread_launch',
        '{}',
        'uncertain',
      );
  } finally {
    raw.close();
  }
  let store = f.open();
  try {
    const principal = { kind: 'human', humanId } as const;
    assert.equal(store.human(humanId)?.username, 'old-owner');
    assert.equal(store.operations.get(operationId).phase, 'uncertain');
    const agent = store.agents.create(principal, teamId, profileInput);
    const credential = store.agents.issue(
      principal,
      teamId,
      agent.id,
      grantInput,
    );
    const execution = store.agents.correlate(
      store.agents.resolveToken(credential.token),
      teamId,
      agent.id,
      correlationInput,
    );
    store.close();
    store = f.open();
    assert.equal(store.agents.get(principal, teamId, agent.id).id, agent.id);
    assert.equal(
      store.agents.correlations(
        store.agents.resolveToken(credential.token),
        teamId,
        agent.id,
      )[0]?.id,
      execution.id,
    );
    assert.equal(store.operations.get(operationId).requestId.length > 0, true);
  } finally {
    store.close();
    f.cleanup();
  }
});
