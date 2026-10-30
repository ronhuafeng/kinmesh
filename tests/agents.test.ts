import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { HumanId, TeamId } from '../src/domain/contracts.js';
import {
  Agent,
  Author,
  Correlation,
  IdentityError,
  ProfileInput,
  RuntimeEvent,
  type Principal,
} from '../src/domain/agents.js';
import { createApp } from '../src/server/app.js';
import { resolvePrincipal } from '../src/server/principals.js';
import {
  agentFixture,
  correlationInput,
  grantInput,
  Issued,
  profileInput,
} from './agent-helpers.js';

await test('agent profile CRUD: immutable stable identity, explicit team membership, validated preferences and lifecycle', async () => {
  const f = await agentFixture();
  try {
    assert.notEqual(f.agent.id, f.owner.id);
    assert.equal(
      (await f.app.inject({ url: f.path, headers: f.headers })).statusCode,
      200,
    );
    const list = await f.app.inject({ url: f.base, cookies: f.cookies });
    assert.equal(z.array(Agent).parse(list.json<unknown>()).length, 1);
    const replacement = {
      ...profileInput,
      name: 'Reviewer',
      role: 'reviewer',
      preferences: {
        environmentId: 'env-two',
        providerId: 'another-provider',
        modelId: 'model-two',
      },
    };
    const updated = await f.app.inject({
      method: 'PUT',
      url: f.path,
      cookies: f.cookies,
      payload: replacement,
    });
    assert.equal(updated.statusCode, 200);
    const agent = Agent.parse(updated.json<unknown>());
    assert.equal(agent.id, f.agent.id);
    assert.equal(agent.role, 'reviewer');
    assert.equal(agent.preferences.environmentId, 'env-two');
    for (const payload of [
      { ...replacement, id: randomUUID() },
      { ...replacement, teamId: randomUUID() },
      { ...replacement, role: 'owner' },
      { ...replacement, active: true },
    ]) {
      assert.equal(
        (
          await f.app.inject({
            method: 'PUT',
            url: f.path,
            cookies: f.cookies,
            payload,
          })
        ).statusCode,
        400,
      );
    }
  } finally {
    await f.dispose();
  }
});

await test('agent schemas reject invalid bindings, unbounded memory/capabilities and runtime identity fields', () => {
  for (const input of [
    {
      ...profileInput,
      preferences: { environmentId: '', providerId: 'codex', modelId: null },
    },
    {
      ...profileInput,
      preferences: {
        environmentId: null,
        providerId: null,
        modelId: 'orphan-model',
      },
    },
    {
      ...profileInput,
      preferences: { environmentId: 'a b', providerId: null, modelId: null },
    },
    { ...profileInput, capabilities: ['duplicate', 'duplicate'] },
    {
      ...profileInput,
      capabilities: Array.from({ length: 33 }, (_, i) => String(i)),
    },
    { ...profileInput, memoryLocation: 'x'.repeat(1025) },
    { ...profileInput, memoryLocation: 'bad\nref' },
    { ...profileInput, t3ThreadId: 'not-an-identity' },
  ])
    assert.equal(ProfileInput.safeParse(input).success, false);
  assert.equal(
    ProfileInput.safeParse({
      ...profileInput,
      preferences: { environmentId: null, providerId: null, modelId: null },
      memoryLocation: null,
    }).success,
    true,
  );
});

await test('team-scoped unique profile names, cross-team IDs and nonmember/nonowner mutations are denied', async () => {
  const f = await agentFixture();
  const raw = new Database(f.dbPath);
  raw.pragma('foreign_keys = ON');
  try {
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.base,
          cookies: f.cookies,
          payload: profileInput,
        })
      ).statusCode,
      409,
    );
    const teamId = TeamId.parse(randomUUID());
    raw.prepare('INSERT INTO teams VALUES (?, ?)').run(teamId, 'Other team');
    assert.throws(
      () => f.store.agents.create(f.principal, teamId, profileInput),
      (e) => e instanceof IdentityError && e.statusCode === 403,
    );
    assert.equal(
      (
        await f.app.inject({
          url: `/api/teams/${teamId}/agents/${f.agent.id}`,
          headers: f.headers,
        })
      ).statusCode,
      403,
    );
    raw
      .prepare('INSERT INTO memberships VALUES (?, ?, ?)')
      .run(f.owner.id, teamId, 'owner');
    const other = f.store.agents.create(f.principal, teamId, profileInput);
    assert.notEqual(other.id, f.agent.id);
    assert.throws(
      () => f.store.agents.get(f.principal, teamId, f.agent.id),
      (e) => e instanceof IdentityError && e.statusCode === 404,
    );
    const memberId = HumanId.parse(randomUUID());
    raw
      .prepare('INSERT INTO humans VALUES (?, ?, ?)')
      .run(memberId, 'member', 'unused-test-hash');
    raw
      .prepare('INSERT INTO memberships VALUES (?, ?, ?)')
      .run(memberId, f.teamId, 'member');
    const member: Principal = { kind: 'human', humanId: memberId };
    for (const action of [
      () => f.store.agents.create(member, f.teamId, profileInput),
      () => f.store.agents.update(member, f.teamId, f.agent.id, profileInput),
      () => f.store.agents.issue(member, f.teamId, f.agent.id, grantInput),
      () => f.store.agents.lifecycle(member, f.teamId, f.agent.id, 'disabled'),
      () => {
        f.store.agents.revoke(member, f.teamId, f.agent.id, f.grant.grant.id);
      },
      () =>
        f.store.agents.rotate(
          member,
          f.teamId,
          f.agent.id,
          f.grant.grant.id,
          grantInput,
        ),
    ])
      assert.throws(
        action,
        (e) => e instanceof IdentityError && e.statusCode === 403,
      );
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('opaque agent credentials use independent 256-bit randomness, hash-only persistence and one-time secret responses', async () => {
  const f = await agentFixture();
  const raw = new Database(f.dbPath);
  try {
    const second = f.store.agents.issue(
      f.principal,
      f.teamId,
      f.agent.id,
      grantInput,
    );
    assert.match(second.token, /^kma_[A-Za-z0-9_-]{43}$/);
    assert.equal(second.token === f.grant.token, false);
    const stored = z
      .object({ token_hash: z.string() })
      .parse(
        raw
          .prepare('SELECT token_hash FROM agent_grants WHERE id = ?')
          .get(second.grant.id),
      );
    assert.equal(
      stored.token_hash ===
        createHash('sha256').update(second.token).digest('hex'),
      true,
    );
    assert.equal(stored.token_hash.includes(second.token), false);
    const get = await f.app.inject({
      url: f.path + '/grants',
      cookies: f.cookies,
    });
    assert.equal(get.statusCode, 200);
    for (const secret of [second.token, f.grant.token, stored.token_hash])
      assert.equal(get.body.includes(secret), false);
    const audit = await f.app.inject({
      url: f.path + '/audit',
      cookies: f.cookies,
    });
    assert.equal(audit.body.includes(second.token), false);
    for (const token of ['kma_bad', 'invalid', 'kma_' + 'x'.repeat(43)]) {
      assert.equal(
        (
          await f.app.inject({
            url: f.path,
            headers: { authorization: 'Bearer ' + token },
          })
        ).statusCode,
        401,
      );
    }
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('agent scopes are checked from persisted grants and never confer human owner or another agent authority', async () => {
  const f = await agentFixture();
  try {
    const scoped = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
      ...grantInput,
      scopes: ['executions:read'],
    });
    const headers = { authorization: 'Bearer ' + scoped.token };
    assert.equal(
      (await f.app.inject({ url: f.path, headers })).statusCode,
      403,
    );
    assert.equal(
      (await f.app.inject({ url: f.path + '/executions', headers })).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path + '/executions',
          headers,
          payload: correlationInput,
        })
      ).statusCode,
      403,
    );
    const agent = f.store.agents.resolveToken(scoped.token);
    assert.equal(agent.kind, 'agent');
    assert.throws(
      () =>
        f.store.agents.authorize(
          { ...agent, scopes: ['tasks:write'] },
          f.teamId,
          f.agent.id,
          'tasks:write',
        ),
      (e) => e instanceof IdentityError && e.statusCode === 403,
    );
    const another = f.store.agents.create(f.principal, f.teamId, {
      ...profileInput,
      name: 'Another',
    });
    assert.equal(
      (
        await f.app.inject({
          url: f.base + '/' + another.id,
          headers: f.headers,
        })
      ).statusCode,
      403,
    );
    for (const url of [
      '/api/me',
      '/api/team',
      f.base,
      f.path + '/grants',
      f.path + '/audit',
    ])
      assert.equal(
        (await f.app.inject({ url, headers: f.headers })).statusCode,
        403,
      );
    for (const [url, payload] of [
      [f.base, profileInput],
      [f.path + '/grants', grantInput],
      [f.path + '/lifecycle', { lifecycle: 'disabled' }],
      [f.path + '/grants/' + f.grant.grant.id + '/revoke', {}],
      [f.path + '/grants/' + f.grant.grant.id + '/rotate', grantInput],
    ] as const) {
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url,
            headers: f.headers,
            payload,
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: f.path,
          headers: f.headers,
          payload: profileInput,
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.dispose();
  }
});

await test('anonymous requests and actor spoofing header/query/body never select a principal', async () => {
  const f = await agentFixture();
  try {
    for (const headers of [
      { 'x-kinmesh-actor': f.owner.id },
      { 'x-actor-id': f.agent.id },
    ]) {
      assert.equal(
        (await f.app.inject({ url: f.path, headers })).statusCode,
        400,
      );
      assert.equal(
        (
          await f.app.inject({
            url: f.path,
            headers: { ...headers, ...f.headers },
          })
        ).statusCode,
        400,
      );
    }
    for (const query of [
      'actor=owner',
      'actorId=' + f.owner.id,
      'role=owner',
      'agentId=' + f.agent.id,
    ]) {
      assert.equal(
        (await f.app.inject({ url: f.path + '?' + query, headers: f.headers }))
          .statusCode,
        400,
      );
    }
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.base,
          payload: profileInput,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: f.path,
          cookies: f.cookies,
          headers: f.headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path + '/executions',
          headers: f.headers,
          payload: {
            ...correlationInput,
            author: { kind: 'human', humanId: f.owner.id },
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path + '/grants',
          cookies: f.cookies,
          payload: { ...grantInput, scopes: ['owner'] },
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.dispose();
  }
});

await test('execution correlations preserve multiple runs, agent provenance and independent immutable lifecycle through provider rebind', async () => {
  const f = await agentFixture();
  try {
    const first = await f.execution();
    const second = f.store.agents.correlate(f.principal, f.teamId, f.agent.id, {
      ...correlationInput,
      reference: { ...correlationInput.reference, runId: 'run-two' },
      invocationId: 'invocation-two',
    });
    assert.equal(Author.parse(first.author).kind, 'agent');
    assert.equal(Author.parse(second.author).kind, 'human');
    const event = await f.app.inject({
      method: 'POST',
      url: f.path + '/executions/' + first.id + '/events',
      headers: f.headers,
      payload: { state: 'succeeded' },
    });
    assert.equal(event.statusCode, 201);
    assert.equal(
      RuntimeEvent.parse(event.json<unknown>()).author.kind,
      'agent',
    );
    f.store.agents.update(f.principal, f.teamId, f.agent.id, {
      ...profileInput,
      preferences: {
        providerId: 'other',
        modelId: null,
        environmentId: 'other-env',
      },
    });
    const correlations = f.store.agents.correlations(
      f.principal,
      f.teamId,
      f.agent.id,
    );
    assert.equal(correlations.length, 2);
    assert.equal(correlations[0]?.reference.environmentId, 'env-one');
    assert.equal(Correlation.parse(first).acceptance, 'not-evaluated');
    assert.equal(
      f.store.agents.runtimeEvents(f.principal, f.teamId, f.agent.id, second.id)
        .length,
      0,
    );
    assert.equal(
      f.store.agents.get(f.principal, f.teamId, f.agent.id).lifecycle,
      'active',
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path + '/executions',
          headers: f.headers,
          payload: correlationInput,
        })
      ).statusCode,
      409,
    );
    const another = f.store.agents.create(f.principal, f.teamId, {
      ...profileInput,
      name: 'Another',
    });
    assert.throws(
      () =>
        f.store.agents.correlate(
          f.principal,
          f.teamId,
          another.id,
          correlationInput,
        ),
      (e) => e instanceof IdentityError && e.statusCode === 409,
    );
  } finally {
    await f.dispose();
  }
});

await test('revoke blocks every agent profile/execution route and stale principals without affecting owner reads', async () => {
  const f = await agentFixture();
  try {
    const execution = await f.execution();
    const stale = f.store.agents.resolveToken(f.grant.token);
    f.store.agents.revoke(f.principal, f.teamId, f.agent.id, f.grant.grant.id);
    for (const action of [
      () => f.store.agents.get(stale, f.teamId, f.agent.id),
      () => f.store.agents.correlations(stale, f.teamId, f.agent.id),
      () =>
        f.store.agents.correlate(stale, f.teamId, f.agent.id, correlationInput),
      () =>
        f.store.agents.runtimeEvents(stale, f.teamId, f.agent.id, execution.id),
      () =>
        f.store.agents.runtimeEvent(
          stale,
          f.teamId,
          f.agent.id,
          execution.id,
          'active',
        ),
      () =>
        f.store.agents.authorize(stale, f.teamId, f.agent.id, 'channels:read'),
      () =>
        f.store.agents.authorize(stale, f.teamId, f.agent.id, 'tasks:write'),
    ])
      assert.throws(
        action,
        (e) => e instanceof IdentityError && e.statusCode === 401,
      );
    for (const url of [
      f.path,
      f.path + '/executions',
      f.path + '/executions/' + execution.id + '/events',
    ])
      assert.equal(
        (await f.app.inject({ url, headers: f.headers })).statusCode,
        401,
      );
    for (const [url, payload] of [
      [f.path + '/executions', correlationInput],
      [f.path + '/executions/' + execution.id + '/events', { state: 'active' }],
    ] as const)
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url,
            headers: f.headers,
            payload,
          })
        ).statusCode,
        401,
      );
    assert.equal(
      (await f.app.inject({ url: f.path, cookies: f.cookies })).statusCode,
      200,
    );
  } finally {
    await f.dispose();
  }
});

await test('disable revokes all grants atomically and reactivation cannot resurrect old credentials', async () => {
  const f = await agentFixture();
  try {
    const execution = await f.execution();
    const second = f.store.agents.issue(
      f.principal,
      f.teamId,
      f.agent.id,
      grantInput,
    );
    const stale = f.store.agents.resolveToken(second.token);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path + '/lifecycle',
          cookies: f.cookies,
          payload: { lifecycle: 'disabled' },
        })
      ).statusCode,
      200,
    );
    for (const token of [second.token, f.grant.token]) {
      for (const url of [
        f.path,
        f.path + '/executions',
        f.path + '/executions/' + execution.id + '/events',
      ])
        assert.equal(
          (
            await f.app.inject({
              url,
              headers: { authorization: 'Bearer ' + token },
            })
          ).statusCode,
          401,
        );
      for (const [url, payload] of [
        [f.path + '/executions', correlationInput],
        [
          f.path + '/executions/' + execution.id + '/events',
          { state: 'active' },
        ],
      ] as const)
        assert.equal(
          (
            await f.app.inject({
              method: 'POST',
              url,
              headers: { authorization: 'Bearer ' + token },
              payload,
            })
          ).statusCode,
          401,
        );
    }
    assert.throws(
      () => f.store.agents.issue(f.principal, f.teamId, f.agent.id, grantInput),
      (e) => e instanceof IdentityError && e.statusCode === 409,
    );
    f.store.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'active');
    assert.throws(
      () => f.store.agents.get(stale, f.teamId, f.agent.id),
      (e) => e instanceof IdentityError && e.statusCode === 401,
    );
    const fresh = f.store.agents.issue(
      f.principal,
      f.teamId,
      f.agent.id,
      grantInput,
    );
    assert.equal(
      (
        await f.app.inject({
          url: f.path,
          headers: { authorization: 'Bearer ' + fresh.token },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      f.store.agents.correlations(f.principal, f.teamId, f.agent.id).length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

await test('credential rotation is atomic, validates scopes/lifetime, and prevents old credential replay', async () => {
  const f = await agentFixture();
  try {
    const url = f.path + '/grants/' + f.grant.grant.id + '/rotate';
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          cookies: f.cookies,
          payload: { ...grantInput, lifetimeSeconds: 0 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ url: f.path, headers: f.headers })).statusCode,
      200,
    );
    const rotated = await f.app.inject({
      method: 'POST',
      url,
      cookies: f.cookies,
      payload: grantInput,
    });
    assert.equal(rotated.statusCode, 201);
    assert.equal(rotated.headers['cache-control'], 'no-store');
    const fresh = Issued.parse(rotated.json<unknown>());
    assert.equal(
      (await f.app.inject({ url: f.path, headers: f.headers })).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          url: f.path,
          headers: { authorization: 'Bearer ' + fresh.token },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          cookies: f.cookies,
          payload: grantInput,
        })
      ).statusCode,
      409,
    );
    for (const payload of [
      { ...grantInput, scopes: [] },
      { ...grantInput, scopes: ['tasks:write', 'tasks:write'] },
      { ...grantInput, lifetimeSeconds: 90 * 86400 + 1 },
    ])
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: f.path + '/grants',
            cookies: f.cookies,
            payload,
          })
        ).statusCode,
        400,
      );
  } finally {
    await f.dispose();
  }
});

await test('expiration and removed human membership are checked on every request', async () => {
  const f = await agentFixture();
  const raw = new Database(f.dbPath);
  try {
    const principal = f.store.agents.resolveToken(f.grant.token);
    raw
      .prepare('UPDATE agent_grants SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', f.grant.grant.id);
    assert.equal(
      (await f.app.inject({ url: f.path, headers: f.headers })).statusCode,
      401,
    );
    assert.throws(
      () => f.store.agents.get(principal, f.teamId, f.agent.id),
      (e) => e instanceof IdentityError && e.statusCode === 401,
    );
    raw.exec('DELETE FROM memberships');
    for (const url of [f.path, f.path + '/executions', f.path + '/grants'])
      assert.equal(
        (await f.app.inject({ url, cookies: f.cookies })).statusCode,
        403,
      );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: f.path + '/grants',
          cookies: f.cookies,
          payload: grantInput,
        })
      ).statusCode,
      403,
    );
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('database constraints enforce immutable identity/history, final revocation and cross-team grant/correlation ownership', async () => {
  const f = await agentFixture();
  const raw = new Database(f.dbPath);
  raw.pragma('foreign_keys = ON');
  try {
    await f.execution();
    for (const sql of [
      "UPDATE agents SET id = 'replacement'",
      "UPDATE agents SET team_id = 'other'",
      "UPDATE agents SET role = 'owner'",
      "UPDATE agents SET lifecycle = 'invalid'",
      'UPDATE agent_correlations SET author = author',
      'DELETE FROM agent_correlations',
      'UPDATE agent_audit SET detail = detail',
      'DELETE FROM agent_audit',
      'UPDATE agent_grants SET agent_id = agent_id',
    ])
      assert.throws(() => raw.exec(sql));
    f.store.agents.runtimeEvent(
      f.principal,
      f.teamId,
      f.agent.id,
      f.store.agents.correlations(f.principal, f.teamId, f.agent.id)[0]?.id ??
        '',
      'active',
    );
    for (const sql of [
      'UPDATE agent_runtime_events SET state = state',
      'DELETE FROM agent_runtime_events',
    ])
      assert.throws(() => raw.exec(sql));
    const teamId = randomUUID();
    raw.prepare('INSERT INTO teams VALUES (?, ?)').run(teamId, 'Other');
    assert.throws(() =>
      raw
        .prepare(
          'INSERT INTO agent_grants SELECT ?, agent_id, ?, ?, label, scopes, issued_by, created_at, expires_at, NULL FROM agent_grants LIMIT 1',
        )
        .run(randomUUID(), teamId, 'a'.repeat(64)),
    );
    assert.throws(() =>
      raw
        .prepare(
          'INSERT INTO agent_correlations SELECT ?, agent_id, ?, reference_key, reference, provider_session_id, invocation_id, author, created_at FROM agent_correlations LIMIT 1',
        )
        .run(randomUUID(), teamId),
    );
    f.store.agents.revoke(f.principal, f.teamId, f.agent.id, f.grant.grant.id);
    assert.throws(() => raw.exec('UPDATE agent_grants SET revoked_at = NULL'));
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('audit failure rolls back profile changes, disable/revocation and rotation without partial mutations', async () => {
  const f = await agentFixture();
  const raw = new Database(f.dbPath);
  try {
    raw.exec(
      "CREATE TRIGGER reject_test_audit BEFORE INSERT ON agent_audit BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
    );
    assert.throws(() =>
      f.store.agents.update(f.principal, f.teamId, f.agent.id, {
        ...profileInput,
        name: 'Changed',
      }),
    );
    assert.equal(
      f.store.agents.get(f.principal, f.teamId, f.agent.id).name,
      'Developer',
    );
    assert.throws(() =>
      f.store.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'disabled'),
    );
    assert.equal(
      f.store.agents.get(f.principal, f.teamId, f.agent.id).lifecycle,
      'active',
    );
    assert.throws(() =>
      f.store.agents.rotate(
        f.principal,
        f.teamId,
        f.agent.id,
        f.grant.grant.id,
        grantInput,
      ),
    );
    assert.equal(
      f.store.agents.grants(f.principal, f.teamId, f.agent.id).length,
      1,
    );
    assert.equal(
      (await f.app.inject({ url: f.path, headers: f.headers })).statusCode,
      200,
    );
  } finally {
    raw.close();
    await f.dispose();
  }
});

await test('service restart preserves stable agent, grant, correlations, provenance and audit independently of runtime lifecycle', async () => {
  const f = await agentFixture();
  let restarted: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const execution = await f.execution();
    const updated = f.store.agents.update(f.principal, f.teamId, f.agent.id, {
      ...profileInput,
      role: 'reviewer',
      preferences: {
        environmentId: 'rebound-env',
        providerId: 'other-provider',
        modelId: 'other-model',
      },
    });
    f.store.agents.runtimeEvent(
      f.principal,
      f.teamId,
      f.agent.id,
      execution.id,
      'succeeded',
    );
    await f.app.close();
    const reopened = f.open();
    restarted = await createApp(f.config, reopened);
    assert.deepEqual(
      reopened.agents.get(f.principal, f.teamId, f.agent.id),
      updated,
    );
    assert.equal(
      (await restarted.inject({ url: f.path, headers: f.headers })).statusCode,
      200,
    );
    assert.equal(
      (await restarted.inject({ url: f.path, cookies: f.cookies })).statusCode,
      200,
    );
    const correlations = await restarted.inject({
      url: f.path + '/executions',
      headers: f.headers,
    });
    assert.equal(
      z.array(Correlation).parse(correlations.json<unknown>())[0]?.id,
      execution.id,
    );
    assert.equal(
      reopened.agents.runtimeEvents(
        f.principal,
        f.teamId,
        f.agent.id,
        execution.id,
      )[0]?.state,
      'succeeded',
    );
    assert.ok(
      reopened.agents.audit(f.principal, f.teamId, f.agent.id).length >= 3,
    );
    assert.equal(
      resolvePrincipal(reopened, f.headers.authorization, undefined).kind,
      'agent',
    );
    reopened.agents.lifecycle(f.principal, f.teamId, f.agent.id, 'disabled');
    await restarted.close();
    const disabledStore = f.open();
    restarted = await createApp(f.config, disabledStore);
    assert.equal(
      disabledStore.agents.get(f.principal, f.teamId, f.agent.id).lifecycle,
      'disabled',
    );
    assert.equal(
      (await restarted.inject({ url: f.path, headers: f.headers })).statusCode,
      401,
    );
    assert.equal(
      disabledStore.agents.correlations(f.principal, f.teamId, f.agent.id)[0]
        ?.id,
      execution.id,
    );
  } finally {
    if (restarted !== undefined) await restarted.close();
    await f.dispose();
  }
});

await test('disabled lifecycle independently blocks unrevoked grants and every profile/execution/admin route', async () => {
  const f = await agentFixture();
  const raw = new Database(f.dbPath);
  try {
    const execution = await f.execution();
    const stale = f.store.agents.resolveToken(f.grant.token);
    raw
      .prepare("UPDATE agents SET lifecycle = 'disabled' WHERE id = ?")
      .run(f.agent.id);
    assert.throws(
      () => f.store.agents.get(stale, f.teamId, f.agent.id),
      (e) => e instanceof IdentityError && e.statusCode === 401,
    );
    const paths = [
      f.base,
      f.path,
      f.path + '/executions',
      f.path + '/executions/' + execution.id + '/events',
      f.path + '/grants',
      f.path + '/audit',
    ];
    for (const url of paths)
      assert.equal(
        (await f.app.inject({ url, headers: f.headers })).statusCode,
        401,
      );
    for (const [url, payload] of [
      [f.base, profileInput],
      [f.path + '/executions', correlationInput],
      [f.path + '/executions/' + execution.id + '/events', { state: 'active' }],
      [f.path + '/lifecycle', { lifecycle: 'active' }],
      [f.path + '/grants', grantInput],
      [f.path + '/grants/' + f.grant.grant.id + '/rotate', grantInput],
      [f.path + '/grants/' + f.grant.grant.id + '/revoke', {}],
    ] as const)
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url,
            headers: f.headers,
            payload,
          })
        ).statusCode,
        401,
      );
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: f.path,
          headers: f.headers,
          payload: profileInput,
        })
      ).statusCode,
      401,
    );
  } finally {
    raw.close();
    await f.dispose();
  }
});
