import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import { Credential } from '../src/adapters/t3/oauth.js';
import type { Hub } from '../src/server/connect.js';
import {
  agentTokenFile,
  managedDirectory,
  t3AuthFile,
  writeAgentToken,
} from '../src/inbox/managed.js';
import { managedBindings, runWorker } from '../src/inbox/worker.js';
import { setTimeout as delay } from 'node:timers/promises';
import { WORKER_GRANT } from '../src/server/connect.js';
import { inboxFixture } from './inbox-helpers.js';
import { loadAgentToken } from '../src/team-mcp/client.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { agentFixture } from './agent-helpers.js';

const endpoint = 'https://t3.test/mcp';
const credential = Credential.parse({
  endpoint,
  environmentId: 'env-live',
  client: { client_id: 'kinmesh-test' },
  tokens: {
    access_token: 'fixture-access',
    token_type: 'Bearer',
    scope: 'orchestration:read orchestration:operate',
  },
});
const mode = (path: string) => statSync(path).mode & 0o777;

/** The owner's app with a T3 that approves when told to; no network. */
async function connectFixture() {
  const f = await agentFixture();
  let approve: (ok: boolean) => void = () => undefined;
  const workers: number[] = [];
  const hub: Partial<Omit<Hub, 'directory'>> = {
    authorize: async (_endpoint, interaction, signal) => {
      await interaction.redirect(
        new URL('https://t3.test/authorize?state=fixture'),
        signal,
      );
      const ok = await new Promise<boolean>((done) => {
        approve = done;
      });
      if (!ok) throw new Error('Denied');
      return credential;
    },
    providers: () =>
      Promise.resolve([{ id: 'isolated-dev', models: ['model-a'] }]),
    discover: () => Promise.resolve('http://127.0.0.1:3773/mcp'),
    ensureWorker: () => {
      workers.push(Date.now());
      return Promise.resolve();
    },
  };
  const app = await createApp(f.config, f.store, undefined, undefined, hub);
  const team = `/api/teams/${f.teamId}`;
  const agentPath = `${team}/agents/${f.agent.id}`;
  const call = (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    headers?: Record<string, string>,
  ) =>
    app.inject({
      method,
      url,
      ...(headers ? { headers } : { cookies: f.cookies }),
      ...(payload ? { payload } : {}),
    });
  const directory = managedDirectory(f.config.database);
  return {
    ...f,
    app,
    call,
    team,
    agentPath,
    directory,
    workers,
    approve: (ok = true) => {
      approve(ok);
    },
    dispose: async () => {
      await app.close();
      await f.dispose();
    },
  };
}
const settle = () => new Promise((done) => setTimeout(done, 20));
const Status = z.object({
  connection: z
    .object({ endpoint: z.string(), environmentId: z.string() })
    .nullable(),
  signIn: z.enum(['waiting', 'failed']).nullable(),
});

await test('the owner connects T3 from the browser; the credential is saved privately and never replaced silently', async () => {
  const f = await connectFixture();
  try {
    const status = async () =>
      Status.parse((await f.call('GET', f.team + '/t3')).json<unknown>());
    assert.deepEqual(await status(), { connection: null, signIn: null });
    const started = await f.call('POST', f.team + '/t3/connect', {
      endpoint,
      replace: false,
    });
    assert.equal(started.statusCode, 200);
    assert.deepEqual(started.json<unknown>(), {
      authorizationUrl: 'https://t3.test/authorize?state=fixture',
    });
    assert.equal((await status()).signIn, 'waiting');
    // One sign-in at a time.
    assert.equal(
      (
        await f.call('POST', f.team + '/t3/connect', {
          endpoint,
          replace: true,
        })
      ).statusCode,
      409,
    );
    f.approve();
    await settle();
    assert.deepEqual(await status(), {
      connection: { endpoint, environmentId: 'env-live' },
      signIn: null,
    });
    // Supervised access is reported, so a read-only approval can be caught.
    assert.equal(
      z
        .object({ connection: z.object({ access: z.string().nullable() }) })
        .parse((await f.call('GET', f.team + '/t3')).json<unknown>()).connection
        .access,
      'operate',
    );
    assert.deepEqual(
      (await f.call('GET', f.team + '/t3/local')).json<unknown>(),
      {
        endpoint: 'http://127.0.0.1:3773/mcp',
      },
    );
    const file = t3AuthFile(f.directory);
    assert.equal(mode(file), 0o600);
    assert.equal(mode(dirname(file)), 0o700);
    // An approved credential is replaced only when asked to.
    assert.equal(
      (
        await f.call('POST', f.team + '/t3/connect', {
          endpoint,
          replace: false,
        })
      ).statusCode,
      409,
    );
    const providers = await f.call('GET', f.team + '/t3/providers');
    assert.deepEqual(providers.json<unknown>(), {
      providers: [{ id: 'isolated-dev', models: ['model-a'] }],
    });
    // A refused sign-in is reported, and nothing is saved.
    await f.call('POST', f.team + '/t3/connect', { endpoint, replace: true });
    f.approve(false);
    await settle();
    assert.equal((await status()).signIn, 'failed');
    assert.equal((await status()).connection?.environmentId, 'env-live');
  } finally {
    await f.dispose();
  }
});

await test('connecting an agent gives the hub’s worker a private credential the browser never sees', async () => {
  const f = await connectFixture();
  try {
    const connect = () =>
      f.call('POST', f.agentPath + '/connect', {
        providerId: 'isolated-dev',
        modelId: 'model-a',
      });
    // T3 first.
    assert.equal((await connect()).statusCode, 409);
    await f.call('POST', f.team + '/t3/connect', { endpoint, replace: false });
    f.approve();
    await settle();
    const first = await connect();
    assert.equal(first.statusCode, 200);
    assert.doesNotMatch(first.body, /kma_/);
    assert.equal(f.workers.length, 1);
    const tokenFile = agentTokenFile(f.directory, f.agent.id);
    assert.equal(mode(tokenFile), 0o600);
    const token = loadAgentToken(tokenFile);
    const worker = f.store.agents.resolveToken(token);
    assert.equal(worker.kind === 'agent' && worker.agentId, f.agent.id);
    assert.deepEqual(
      f.store.agents.get(f.principal, f.teamId, f.agent.id).preferences,
      {
        environmentId: 'env-live',
        providerId: 'isolated-dev',
        modelId: 'model-a',
      },
    );
    // The worker serves it, and the workspace knows.
    assert.deepEqual(
      managedBindings(f.store, f.directory).map((b) => [
        b.agentId,
        b.isolatedProviderId,
        b.t3Endpoint,
        b.tokenFile,
      ]),
      [[f.agent.id, 'isolated-dev', endpoint, tokenFile]],
    );
    const snapshot = WorkspaceSnapshot.parse(
      (await f.call('GET', '/api/workspace')).json<unknown>(),
    );
    assert.deepEqual(
      snapshot.managed.map((m) => [m.agentId, m.providerId]),
      [[f.agent.id, 'isolated-dev']],
    );
    // The hub rotates by reconnecting; a browser rotation would strand the worker.
    const managed = f.store.managed.binding(f.principal, f.teamId, f.agent.id);
    assert.ok(managed);
    assert.equal(
      (
        await f.call(
          'POST',
          `${f.agentPath}/grants/${managed.grantId}/rotate`,
          {
            label: 'x',
            scopes: ['channels:read'],
            lifetimeSeconds: 600,
          },
        )
      ).statusCode,
      409,
    );
    assert.equal((await connect()).statusCode, 200);
    assert.notEqual(loadAgentToken(tokenFile), token);
    assert.throws(() => f.store.agents.resolveToken(token));
    // Disabling revokes it; re-enabling a connected agent gives a fresh one.
    await f.call('POST', f.agentPath + '/lifecycle', { lifecycle: 'disabled' });
    const revoked = loadAgentToken(tokenFile);
    assert.throws(() => f.store.agents.resolveToken(revoked));
    await f.call('POST', f.agentPath + '/lifecycle', { lifecycle: 'active' });
    assert.ok(f.store.agents.resolveToken(loadAgentToken(tokenFile)));
    // Revoking the worker credential from the list disconnects the agent.
    const current = f.store.managed.binding(f.principal, f.teamId, f.agent.id);
    assert.ok(current);
    assert.equal(
      (await f.call('POST', `${f.agentPath}/grants/${current.grantId}/revoke`))
        .statusCode,
      204,
    );
    assert.equal(existsSync(tokenFile), false);
    assert.deepEqual(managedBindings(f.store, f.directory), []);
    // Connect, then disconnect explicitly.
    assert.equal((await connect()).statusCode, 200);
    const last = loadAgentToken(tokenFile);
    assert.equal(
      (await f.call('POST', f.agentPath + '/disconnect')).statusCode,
      204,
    );
    assert.equal(existsSync(tokenFile), false);
    assert.throws(() => f.store.agents.resolveToken(last));
    // A model is required, and agents never reach these routes.
    assert.equal(
      (
        await f.call('POST', f.agentPath + '/connect', {
          providerId: 'isolated-dev',
        })
      ).statusCode,
      400,
    );
    // A valid agent credential, with every scope it can hold, is still not an owner.
    const valid = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
      label: 'agent',
      scopes: ['agents:read', 'channels:read', 'channels:write'],
      lifetimeSeconds: 600,
    });
    for (const [method, url] of [
      ['GET', f.team + '/t3'],
      ['POST', f.agentPath + '/disconnect'],
    ] as const)
      assert.equal(
        (
          await f.call(method, url, undefined, {
            authorization: 'Bearer ' + valid.token,
          })
        ).statusCode,
        403,
      );
    assert.equal(
      readFileSync(t3AuthFile(f.directory), 'utf8').includes('kma_'),
      false,
    );
  } finally {
    await f.dispose();
  }
});

await test('Team MCP presence is recorded per agent and shown as evidence', async () => {
  const f = await connectFixture();
  try {
    const agent = f.store.agents.resolveToken(f.grant.token);
    f.store.managed.seenByTeamMcp(agent);
    f.store.managed.seenByTeamMcp(f.principal);
    const snapshot = WorkspaceSnapshot.parse(
      (await f.call('GET', '/api/workspace')).json<unknown>(),
    );
    assert.deepEqual(
      snapshot.teamMcp.map((r) => r.agentId),
      [f.agent.id],
    );
  } finally {
    await f.dispose();
  }
});

await test('the hub’s worker serves a connected agent without a restart and lets go when disconnected', async () => {
  const f = await inboxFixture();
  const stopping = new AbortController();
  try {
    f.store.managed.saveConnection(f.principal, f.teamId, endpoint, 'env-live');
    const running = runWorker(
      f.store,
      { ...f.workerConfig, bindings: [], pollMs: 100 },
      f.factory,
      stopping.signal,
    );
    const live = () => f.inbox.liveness(f.teamId).map((r) => r.agentId);
    await delay(200);
    assert.deepEqual(live(), []);
    const { token } = f.store.managed.connect(
      f.principal,
      f.teamId,
      f.agent.id,
      { providerId: 'isolated-dev', modelId: 'model-a' },
      WORKER_GRANT,
    );
    writeAgentToken(managedDirectory(f.dbPath), f.agent.id, token);
    await delay(300);
    assert.deepEqual(live(), [f.agent.id]);
    f.store.managed.disconnect(f.principal, f.teamId, f.agent.id);
    await delay(300);
    assert.deepEqual(live(), []);
    stopping.abort();
    await running;
  } finally {
    stopping.abort();
    await f.dispose();
  }
});
