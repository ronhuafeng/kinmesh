import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventType, PROTOCOL_VERSION } from '@ag-ui/core';
import { StateSnapshotEventSchema } from '@ag-ui/core/schemas';
import { agentFixture } from './agent-helpers.js';
import { AgentId } from '../src/domain/contracts.js';
import {
  WorkspaceSnapshot,
  decodeExecutionEvent,
} from '../src/workspace/contracts.js';
await test('protected workspace and AG-UI 1.0 snapshots reconstruct persisted reports without native or fabricated lifecycle events', async () => {
  const f = await agentFixture();
  try {
    const unauthorized = await f.app.inject({ url: '/api/workspace' });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(
      (await f.app.inject({ url: '/api/workspace', headers: f.headers }))
        .statusCode,
      403,
    );
    const workspace = await f.app.inject({
      url: '/api/workspace',
      cookies: f.cookies,
    });
    assert.equal(workspace.statusCode, 200);
    assert.equal(workspace.headers['cache-control'], 'no-store');
    const snapshot = WorkspaceSnapshot.parse(workspace.json<unknown>());
    assert.equal(snapshot.human.id, f.owner.id);
    assert.deepEqual(snapshot.joinedAgentIds, []);
    assert.equal(snapshot.agents[0]?.id, f.agent.id);
    const execution = await f.execution();
    f.store.agents.runtimeEvent(
      f.principal,
      f.teamId,
      f.agent.id,
      execution.id,
      'waiting',
    );
    const url = `/api/agui/${f.teamId}/${f.agent.id}`;
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    assert.equal(
      (await f.app.inject({ url, headers: f.headers })).statusCode,
      403,
    );
    const response = await f.app.inject({ url, cookies: f.cookies });
    assert.equal(response.statusCode, 200);
    const event = StateSnapshotEventSchema.parse(response.json<unknown>());
    assert.equal(event.type, EventType.STATE_SNAPSHOT);
    const state = decodeExecutionEvent(response.json<unknown>());
    assert.equal(state.protocolVersion, PROTOCOL_VERSION);
    assert.equal(state.source, 'kinmesh-persisted-reports');
    assert.equal(state.executions[0]?.events[0]?.state, 'waiting');
    assert.equal(state.executions[0].correlation.reference.runId, 'run-one');
    assert.equal(
      (
        await f.app.inject({
          url: `/api/agui/${randomUUID()}/${f.agent.id}`,
          cookies: f.cookies,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.app.inject({ url: url + '?actor=owner', cookies: f.cookies }))
        .statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ url, headers: { 'x-kinmesh-actor': f.owner.id } }))
        .statusCode,
      400,
    );
    assert.throws(() =>
      decodeExecutionEvent({ type: EventType.RUN_STARTED, snapshot: state }),
    );
    assert.throws(() =>
      decodeExecutionEvent({
        type: EventType.STATE_SNAPSHOT,
        snapshot: { ...state, source: 'live-t3' },
      }),
    );
  } finally {
    await f.dispose();
  }
});
await test('web assets cannot shadow protected API, health or private repository resources', async () => {
  const f = await agentFixture();
  try {
    const root = await f.app.inject({ url: '/' });
    assert.ok([200, 503].includes(root.statusCode));
    assert.match(
      String(root.headers['content-security-policy']),
      /frame-ancestors 'none'/,
    );
    assert.equal(root.headers['x-content-type-options'], 'nosniff');
    for (const url of [
      '/.env',
      '/src/server/app.ts',
      '/.store/kinmesh.sqlite',
      '/assets/../.env',
    ]) {
      assert.equal((await f.app.inject({ url })).statusCode, 404);
    }
    assert.equal(
      (await f.app.inject({ url: '/api/not-a-page' })).statusCode,
      401,
    );
    assert.equal((await f.app.inject({ url: '/health' })).statusCode, 200);
  } finally {
    await f.dispose();
  }
});

await test('execution projection bounds SQL history and preserves last appended state and truncation', async () => {
  const f = await agentFixture();
  try {
    let latestId = '';
    for (let i = 0; i < 22; i++) {
      const correlation = f.store.agents.correlate(
        f.principal,
        f.teamId,
        f.agent.id,
        {
          reference: {
            backend: 't3',
            environmentId: 'local-fixture',
            threadId: 'local-fixture-thread',
            runId: `local-fixture-${String(i)}`,
          },
          providerSessionId: null,
          invocationId: null,
        },
      );
      latestId = correlation.id;
    }
    for (let i = 0; i < 102; i++)
      f.store.agents.runtimeEvent(
        f.principal,
        f.teamId,
        f.agent.id,
        latestId,
        i === 101 ? 'waiting' : 'active',
      );
    const result = f.store.agents.workspaceExecutions(
      f.principal,
      f.teamId,
      f.agent.id,
    );
    assert.equal(result.executions.length, 20);
    assert.equal(result.executionsTruncated, true);
    const latest = result.executions[0];
    assert.ok(latest);
    assert.equal(latest.correlation.id, latestId);
    assert.equal(latest.events.length, 100);
    assert.equal(latest.eventsTruncated, true);
    assert.equal(latest.events.at(-1)?.state, 'waiting');
    assert.throws(() =>
      f.store.agents.workspaceExecutions(
        f.store.agents.resolveToken(f.grant.token),
        f.teamId,
        AgentId.parse(randomUUID()),
      ),
    );
  } finally {
    await f.dispose();
  }
});
