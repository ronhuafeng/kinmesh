import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';
import { HumanId, TeamId } from '../src/domain/contracts.js';
import { fixture } from './helpers.js';
import { profileInput, grantInput, correlationInput } from './agent-helpers.js';

await test('upgrade from populated foundation/adapter migrations preserves owner, operation journal and new agent state across reopen', () => {
  const f = fixture();
  const oldFolder = join(f.directory, 'old-migrations');
  mkdirSync(join(oldFolder, 'meta'), { recursive: true });
  const journal = z
    .object({
      entries: z.array(z.object({ idx: z.number(), tag: z.string() }).loose()),
    })
    .loose()
    .parse(
      JSON.parse(
        readFileSync(
          new URL('../drizzle/meta/_journal.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  const oldEntries = journal.entries.filter((e) => e.idx < 2);
  assert.equal(oldEntries.length, 2);
  writeFileSync(
    join(oldFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: oldEntries }),
  );
  for (const entry of oldEntries)
    copyFileSync(
      new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
      join(oldFolder, entry.tag + '.sql'),
    );
  const humanId = HumanId.parse(randomUUID());
  const teamId = TeamId.parse(randomUUID());
  const operationId = randomUUID();
  const raw = new Database(f.path);
  raw.pragma('foreign_keys = ON');
  raw.pragma('journal_mode = WAL');
  try {
    migrate(drizzle(raw), { migrationsFolder: oldFolder });
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
    assert.equal(store.credentials('old-owner')?.id, humanId);
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
