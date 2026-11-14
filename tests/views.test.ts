import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IdentityError, type Principal } from '../src/domain/agents.js';
import { TeamId } from '../src/domain/contracts.js';
import { inboxFixture } from './inbox-helpers.js';
import { key } from './communication-helpers.js';
import { profileInput } from './agent-helpers.js';
import { feishuPerson } from './feishu.js';
import { rawDatabase } from './raw.js';

await test('what the workspace reads about a team checks who asks, not the route', async () => {
  const f = await inboxFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    const owner = f.principal;
    const views = f.store.inboxViews;
    const managed = f.store.managed;
    const reads: [string, (p: Principal) => Promise<unknown>][] = [
      [
        'deliveries',
        (p) =>
          views.deliveriesFor(p, f.teamId, f.channelId, [], [randomUUID()]),
      ],
      ['blocked', (p) => views.blockedIn(p, f.teamId)],
      ['queued', (p) => views.queuedPerAgent(p, f.teamId)],
      [
        'replies',
        (p) => views.repliesFor(p, f.teamId, f.channelId, [randomUUID()]),
      ],
      ['liveness', (p) => views.liveness(p, f.teamId)],
      ['bindings', (p) => managed.teamBindings(p, f.teamId)],
      ['Team MCP presence', (p) => managed.teamMcpPresence(p, f.teamId)],
      ['people', (p) => f.store.people(p, f.teamId, Date.now())],
      ['T3 connection', (p) => managed.teamConnection(p, f.teamId)],
    ];
    for (const [name, read] of reads)
      await read(owner).then(
        () => undefined,
        (error: unknown) => {
          assert.fail(`${name} refused a person of the team: ${String(error)}`);
        },
      );

    // A person who is no longer a member of the team.
    const gone = await f.store.signIn(feishuPerson('gone@example.com'));
    await raw.pragma('foreign_keys = OFF');
    await raw
      .prepare('DELETE FROM memberships WHERE human_id = ?')
      .run(gone.id);
    await raw.pragma('foreign_keys = ON');
    const outsider: Principal = { kind: 'human', humanId: gone.id };

    // An agent of another team, holding every scope.
    const foreign = TeamId.parse(randomUUID());
    await raw
      .prepare('INSERT INTO teams VALUES (?, ?)')
      .run(foreign, 'Foreign');
    await raw
      .prepare('INSERT INTO memberships VALUES (?, ?)')
      .run(owner.humanId, foreign);
    const stranger = await f.store.agents.create(owner, foreign, {
      ...profileInput,
      name: 'Stranger',
    });
    const strangerGrant = await f.store.agents.issue(
      owner,
      foreign,
      stranger.id,
      {
        label: 'Every scope',
        scopes: [
          'agents:read',
          'channels:read',
          'channels:write',
          'tasks:read',
          'tasks:write',
          'tasks:review',
          'executions:read',
          'executions:write',
        ],
        lifetimeSeconds: 3600,
      },
    );
    const foreignAgent = await f.store.agents.resolveToken(strangerGrant.token);

    for (const [name, read] of reads)
      for (const [who, p] of [
        ['someone outside the team', outsider],
        ['an agent of another team', foreignAgent],
      ] as const)
        await assert.rejects(read(p), IdentityError, `${name}: ${who}`);

    // The workspace's own views are for people, even of this team.
    for (const [name, read] of reads.slice(0, 7))
      await assert.rejects(read(f.workerPrincipal), IdentityError, name);

    // A channel's deliveries and replies need that channel.
    const left = await f.store.signIn(feishuPerson('left@example.com'));
    const leaver: Principal = { kind: 'human', humanId: left.id };
    await f.comm.membership(
      leaver,
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    for (const [name, read] of reads.filter(
      ([n]) => n === 'deliveries' || n === 'replies',
    ))
      await assert.rejects(read(leaver), IdentityError, name);
  } finally {
    await raw.close();
    await f.dispose();
  }
});
