import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';
import { HumanId, TeamId, ChannelId } from '../src/domain/contracts.js';
import { agentRepository } from '../src/persistence/agents.js';
import * as schema from '../src/persistence/schema.js';
import { fixture } from './helpers.js';
import { profileInput } from './agent-helpers.js';
import {
  postInput,
  key,
  communicationFixture,
} from './communication-helpers.js';

await test('populated #1–#3 upgrade preserves identity/grant and backfills general owner membership without enrolling other members/agents', () => {
  const f = fixture();
  const folder = join(f.directory, 'old');
  mkdirSync(join(folder, 'meta'), { recursive: true });
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
  const entries = journal.entries.filter((e) => e.idx < 3);
  assert.equal(entries.length, 3);
  writeFileSync(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const e of entries)
    copyFileSync(
      new URL('../drizzle/' + e.tag + '.sql', import.meta.url),
      join(folder, e.tag + '.sql'),
    );
  const humanId = HumanId.parse(randomUUID()),
    memberId = HumanId.parse(randomUUID()),
    teamId = TeamId.parse(randomUUID()),
    channelId = ChannelId.parse(randomUUID());
  const p = { kind: 'human', humanId } as const;
  const raw = new Database(f.path);
  raw.pragma('foreign_keys = ON');
  raw.pragma('journal_mode = WAL');
  migrate(drizzle(raw), { migrationsFolder: folder });
  raw
    .prepare('INSERT INTO humans VALUES (?,?,?)')
    .run(humanId, 'owner', 'test-hash');
  raw
    .prepare('INSERT INTO humans VALUES (?,?,?)')
    .run(memberId, 'member', 'test-hash');
  raw.prepare('INSERT INTO teams VALUES (?,?)').run(teamId, 'Old team');
  raw
    .prepare('INSERT INTO memberships VALUES (?,?,?)')
    .run(humanId, teamId, 'owner');
  raw
    .prepare('INSERT INTO memberships VALUES (?,?,?)')
    .run(memberId, teamId, 'member');
  raw
    .prepare('INSERT INTO channels VALUES (?,?,?)')
    .run(channelId, teamId, 'general');
  raw
    .prepare('INSERT INTO bootstrap VALUES (1,?)')
    .run(new Date().toISOString());
  const agents = agentRepository(drizzle(raw, { schema }));
  const agent = agents.create(p, teamId, profileInput);
  const grant = agents.issue(p, teamId, agent.id, {
    label: 'Old read grant',
    scopes: ['channels:read'],
    lifetimeSeconds: 3600,
  });
  raw.close();
  let store = f.open();
  try {
    assert.equal(
      store.communication.channels(p, teamId).items[0]?.id,
      channelId,
    );
    assert.equal(store.teamFor(humanId)?.channels[0]?.id, channelId);
    assert.equal(
      store.communication.channels({ kind: 'human', humanId: memberId }, teamId)
        .items.length,
      0,
    );
    assert.equal(
      store.communication.channels(
        store.agents.resolveToken(grant.token),
        teamId,
      ).items.length,
      0,
    );
    const message = store.communication.post(p, teamId, channelId, postInput());
    store.close();
    store = f.open();
    assert.equal(
      store.communication.history(p, teamId, channelId).items[0]?.id,
      message.id,
    );
    assert.equal(store.agents.get(p, teamId, agent.id).id, agent.id);
  } finally {
    store.close();
    f.cleanup();
  }
});

await test('communication SQL constraints and immutable facts prevent cross-channel topic/mention bindings and history rewriting', async () => {
  const f = await communicationFixture();
  const raw = new Database(f.dbPath);
  raw.pragma('foreign_keys = ON');
  try {
    f.invite();
    const topic = f.comm.createTopic(f.principal, f.teamId, f.channelId, {
      operationKey: key(),
      title: 'One',
    });
    f.comm.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({
        topicId: topic.id,
        mentions: [{ kind: 'agent', id: f.agent.id }],
      }),
    );
    const other = f.comm.createChannel(f.principal, f.teamId, {
      operationKey: key(),
      name: 'Other',
    });
    for (const table of [
      'channels',
      'topics',
      'messages',
      'message_mentions',
      'communication_outbox',
      'communication_operations',
    ]) {
      assert.throws(() => raw.exec('DELETE FROM ' + table));
    }
    assert.throws(() =>
      raw.prepare('UPDATE messages SET body=?').run('rewrite'),
    );
    assert.throws(() =>
      raw
        .prepare(
          'INSERT INTO messages (id,channel_id,topic_id,author,created_at,body) VALUES (?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          other.id,
          topic.id,
          '{}',
          new Date().toISOString(),
          'Invalid target',
        ),
    );
    assert.throws(() =>
      raw
        .prepare('INSERT INTO channel_participants VALUES (?,?,?,?,?,?)')
        .run(
          other.id,
          f.teamId,
          'human:' + f.agent.id,
          f.agent.id,
          null,
          'joined',
        ),
    );
    const rows = z
      .array(z.object({ fact: z.string() }))
      .parse(raw.prepare('SELECT fact FROM communication_outbox').all());
    assert.ok(rows.length >= 4);
  } finally {
    raw.close();
    await f.dispose();
  }
});
