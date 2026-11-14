import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { migrateTo } from './migration-helpers.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { HumanId, TeamId, ChannelId } from '../src/domain/contracts.js';
import { agentRepository } from '../src/persistence/agents.js';
import { communicationRepository } from '../src/persistence/communication.js';
import * as schema from '../src/persistence/schema.js';
import { fixture } from './helpers.js';
import { IdentityError } from '../src/domain/agents.js';
import { key } from './communication-helpers.js';
import { profileInput } from './agent-helpers.js';
import { postInput } from './communication-helpers.js';
import { taskInput } from './task-helpers.js';
await test('populated #1–#4 upgrade retains channel/message/outbox/profile/grant state without widening old task scopes', async () => {
  const f = fixture();
  const humanId = HumanId.parse(randomUUID()),
    teamId = TeamId.parse(randomUUID()),
    channelId = ChannelId.parse(randomUUID());
  const p = { kind: 'human', humanId } as const;
  const raw = new Database(f.path);
  raw.pragma('foreign_keys = ON');
  raw.pragma('journal_mode = WAL');
  migrateTo(raw, f.directory, 4);
  raw
    .prepare('INSERT INTO humans VALUES (?,?,?)')
    .run(humanId, 'owner', 'migration-test-hash');
  raw.prepare('INSERT INTO teams VALUES (?,?)').run(teamId, 'Old team');
  raw
    .prepare('INSERT INTO memberships VALUES (?,?,?)')
    .run(humanId, teamId, 'owner');
  raw
    .prepare('INSERT INTO channels VALUES (?,?,?,?)')
    .run(channelId, teamId, 'general', 1);
  raw
    .prepare('INSERT INTO channel_participants VALUES (?,?,?,?,?,?)')
    .run(channelId, teamId, 'human:' + humanId, humanId, null, 'joined');
  raw
    .prepare('INSERT INTO bootstrap VALUES (1,?)')
    .run(new Date().toISOString());
  const db = drizzle(raw, { schema });
  const agents = agentRepository(db);
  const comm = communicationRepository(db, agents);
  const agent = agents.create(p, teamId, profileInput);
  const oldGrant = agents.issue(p, teamId, agent.id, {
    label: 'Old task write',
    scopes: ['channels:read', 'tasks:write'],
    lifetimeSeconds: 3600,
  });
  comm.enroll(
    p,
    teamId,
    channelId,
    { operationKey: key(), member: { kind: 'agent', id: agent.id } },
    'invite',
  );
  const message = comm.post(p, teamId, channelId, postInput());
  const facts = comm.events(p, teamId, channelId);
  raw.close();
  let store = f.open();
  try {
    assert.equal(
      (await store.communication.history(p, teamId, channelId)).items[0]?.id,
      message.id,
    );
    assert.deepEqual(
      await store.communication.events(p, teamId, channelId),
      facts,
    );
    assert.equal((await store.agents.get(p, teamId, agent.id)).id, agent.id);
    assert.throws(
      async () =>
        store.tasks.list(
          await store.agents.resolveToken(oldGrant.token),
          teamId,
          channelId,
        ),
      (error) => error instanceof IdentityError && error.statusCode === 403,
    );
    const created = await store.tasks.create(
      p,
      teamId,
      channelId,
      taskInput({ sourceMessageId: message.id }),
    );
    await store.close();
    store = f.open();
    assert.deepEqual(
      await store.tasks.get(p, teamId, channelId, created.task.id),
      created.task,
    );
    assert.equal(
      (await store.tasks.history(p, teamId, channelId, created.task.id))
        .items[0]?.sourceEventId,
      null,
    );
  } finally {
    await store.close();
    f.cleanup();
  }
});
