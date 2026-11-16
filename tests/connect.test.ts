import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import {
  Credential,
  loadCredential,
  saveCredential,
} from '../src/adapters/t3/oauth.js';
import type { Hub } from '../src/server/connect.js';
import {
  agentTokenFile,
  managedDirectory,
  t3AuthFile,
  t3DeploymentFile,
  writeAgentToken,
} from '../src/inbox/managed.js';
import { managedBindings, runWorker } from '../src/inbox/worker.js';
import { setTimeout as delay } from 'node:timers/promises';
import { WORKER_GRANT } from '../src/server/connect.js';
import { inboxFixture } from './inbox-helpers.js';
import { loadAgentToken } from '../src/team-mcp/client.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { agentFixture, profileInput } from './agent-helpers.js';
import { signInAs, standInFeishu } from './feishu.js';
import { rawDatabase } from './raw.js';

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

/** The team's app with a T3 that approves when told to; no network. */
async function connectFixture(overrides: Partial<Omit<Hub, 'directory'>> = {}) {
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
    // The person chose Full access on T3's approval page.
    ceiling: () => Promise.resolve('full-access' as const),
    discover: () => Promise.resolve('http://127.0.0.1:3773/mcp'),
    ensureWorker: () => {
      workers.push(Date.now());
      return Promise.resolve();
    },
    ...overrides,
  };
  const app = await createApp(f.config, f.store, undefined, undefined, hub, {
    feishu: standInFeishu,
  });
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
  const directory = managedDirectory(f.config.state);
  /**
   * The hub's change stream, as the agent page watches it, which names T3's
   * status: opened on first use, kept until the app closes.
   */
  let stream: AsyncIterator<unknown> | undefined;
  /** Resolves when the hub next says what the page shows may have changed. */
  const changed = async () => {
    stream ??= (
      await app.inject({
        url: `/api/events?page=agent:${f.agent.id}`,
        cookies: f.cookies,
        payloadAsStream: true,
      })
    )
      .stream()
      [Symbol.asyncIterator]();
    if ((await stream.next()).done === true)
      throw new Error('The hub ended its change stream');
  };
  return {
    ...f,
    app,
    call,
    team,
    agentPath,
    directory,
    workers,
    changed,
    approve: (ok = true) => {
      approve(ok);
    },
    dispose: async () => {
      await app.close();
      await f.dispose();
    },
  };
}
const Status = z.object({
  connection: z
    .object({ endpoint: z.string(), environmentId: z.string() })
    .nullable(),
  signIn: z.enum(['waiting', 'failed']).nullable(),
});
/**
 * Waits until the T3 sign-in has ended, approved or not: T3's status is read
 * again only when the hub says it may have changed, so the wait is bounded by
 * the sign-in's own steps, never by the hub's request limit.
 */
async function settle(f: Awaited<ReturnType<typeof connectFixture>>) {
  for (;;) {
    const status = Status.parse(
      (await f.call('GET', f.team + '/t3')).json<unknown>(),
    );
    if (status.signIn !== 'waiting') return;
    await f.changed();
  }
}

await test('a person who did not set up the instance connects T3 and registers an agent', async () => {
  const f = await connectFixture();
  try {
    // Someone else in the organization, signing in after the team exists.
    const cookies = await signInAs(f.app, 'colleague@example.com');
    const as = (method: 'GET' | 'POST', url: string, payload?: object) =>
      f.app.inject({ method, url, cookies, ...(payload ? { payload } : {}) });
    const started = await as('POST', f.team + '/t3/connect', {
      endpoint,
      replace: false,
    });
    assert.equal(started.statusCode, 200);
    f.approve();
    await settle(f);
    assert.equal(
      Status.parse((await as('GET', f.team + '/t3')).json<unknown>()).connection
        ?.environmentId,
      'env-live',
    );
    const registered = await as('POST', f.team + '/agents', {
      ...profileInput,
      name: 'Colleague’s agent',
    });
    assert.equal(registered.statusCode, 201);
  } finally {
    await f.dispose();
  }
});

await test('a person connects T3 from the browser; the credential is saved privately and never replaced silently', async () => {
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
    await settle(f);
    assert.deepEqual(await status(), {
      connection: { endpoint, environmentId: 'env-live' },
      signIn: null,
    });
    // Operate access is reported, so a read-only approval can be caught,
    // and so is the mode the person chose, which runs launch in.
    assert.deepEqual(
      z
        .object({
          connection: z.object({
            access: z.string().nullable(),
            ceiling: z.string().nullable(),
          }),
        })
        .parse((await f.call('GET', f.team + '/t3')).json<unknown>())
        .connection,
      { access: 'operate', ceiling: 'full-access' },
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
    await settle(f);
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
    await settle(f);
    const first = await connect();
    assert.equal(first.statusCode, 200);
    assert.doesNotMatch(first.body, /kma_/);
    assert.equal(f.workers.length, 1);
    const tokenFile = agentTokenFile(f.directory, f.agent.id);
    assert.equal(mode(tokenFile), 0o600);
    const token = loadAgentToken(tokenFile);
    const worker = await f.store.agents.resolveToken(token);
    assert.equal(worker.kind === 'agent' && worker.agentId, f.agent.id);
    assert.deepEqual(
      (await f.store.agents.get(f.principal, f.teamId, f.agent.id)).preferences,
      {
        environmentId: 'env-live',
        providerId: 'isolated-dev',
        modelId: 'model-a',
      },
    );
    // The worker serves it, and the workspace knows.
    assert.deepEqual(
      (await managedBindings(f.store, f.directory)).map((b) => [
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
    // Only the hub hands the worker its credential; a browser rotation would strand it.
    const managed = await f.store.managed.binding(
      f.principal,
      f.teamId,
      f.agent.id,
    );
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
    // Choosing another model changes what it runs on, not its credential:
    // a run under way can still post its answer.
    const grantsBefore = await f.store.agents.grants(
      f.principal,
      f.teamId,
      f.agent.id,
    );
    assert.equal(
      (
        await f.call('POST', f.agentPath + '/connect', {
          providerId: 'isolated-other',
          modelId: 'model-b',
        })
      ).statusCode,
      200,
    );
    assert.equal(loadAgentToken(tokenFile), token);
    assert.ok(await f.store.agents.resolveToken(token));
    assert.deepEqual(
      await f.store.agents.grants(f.principal, f.teamId, f.agent.id),
      grantsBefore,
    );
    assert.deepEqual(
      (await f.store.agents.get(f.principal, f.teamId, f.agent.id)).preferences,
      {
        environmentId: 'env-live',
        providerId: 'isolated-other',
        modelId: 'model-b',
      },
    );
    assert.deepEqual(
      (await managedBindings(f.store, f.directory)).map(
        (b) => b.isolatedProviderId,
      ),
      ['isolated-other'],
    );
    // Disabling revokes it; re-enabling a connected agent gives a fresh one.
    await f.call('POST', f.agentPath + '/lifecycle', { lifecycle: 'disabled' });
    const revoked = loadAgentToken(tokenFile);
    await assert.rejects(() => f.store.agents.resolveToken(revoked));
    await f.call('POST', f.agentPath + '/lifecycle', { lifecycle: 'active' });
    assert.ok(await f.store.agents.resolveToken(loadAgentToken(tokenFile)));
    // Revoking the worker credential from the list disconnects the agent.
    const current = await f.store.managed.binding(
      f.principal,
      f.teamId,
      f.agent.id,
    );
    assert.ok(current);
    assert.equal(
      (await f.call('POST', `${f.agentPath}/grants/${current.grantId}/revoke`))
        .statusCode,
      204,
    );
    assert.equal(existsSync(tokenFile), false);
    assert.deepEqual(await managedBindings(f.store, f.directory), []);
    // Connect, then disconnect explicitly.
    assert.equal((await connect()).statusCode, 200);
    const last = loadAgentToken(tokenFile);
    assert.equal(
      (await f.call('POST', f.agentPath + '/disconnect')).statusCode,
      204,
    );
    assert.equal(existsSync(tokenFile), false);
    await assert.rejects(() => f.store.agents.resolveToken(last));
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
    const valid = await f.store.agents.issue(
      f.principal,
      f.teamId,
      f.agent.id,
      {
        label: 'agent',
        scopes: ['agents:read', 'channels:read', 'channels:write'],
        lifetimeSeconds: 600,
      },
    );
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
    const agent = await f.store.agents.resolveToken(f.grant.token);
    await f.store.managed.seenByTeamMcp(agent);
    await f.store.managed.seenByTeamMcp(f.principal);
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
    await f.store.managed.saveConnection(
      f.principal,
      f.teamId,
      endpoint,
      'env-live',
    );
    const running = runWorker(
      f.store,
      { ...f.workerConfig, bindings: [], pollMs: 100 },
      f.factory,
      stopping.signal,
    );
    const live = async () =>
      (await f.store.inboxViews.liveness(f.principal, f.teamId)).map(
        (r) => r.agentId,
      );
    await delay(200);
    assert.deepEqual(await live(), []);
    const issued = await f.store.managed.connect(
      f.principal,
      f.teamId,
      f.agent.id,
      { providerId: 'isolated-dev', modelId: 'model-a' },
      WORKER_GRANT,
    );
    assert.ok(issued);
    const { token } = issued;
    writeAgentToken(managedDirectory(f.directory), f.agent.id, token);
    await delay(300);
    assert.deepEqual(await live(), [f.agent.id]);
    await f.store.managed.disconnect(f.principal, f.teamId, f.agent.id);
    await delay(300);
    assert.deepEqual(await live(), []);
    stopping.abort();
    await running;
  } finally {
    stopping.abort();
    await f.dispose();
  }
});

/**
 * Proves the credential the hub holds for its own worker never runs out
 * while the agent stays connected: the hub renews it in place (the same
 * grant, the same token) when it starts and when someone connects again,
 * even after it ended; a revocation stays final, and a credential a person
 * issued is left to end.
 */
await test('the hub’s worker credential is renewed in place while the agent stays connected; a revoked one never is', async () => {
  const f = await agentFixture();
  const raw = rawDatabase(f.dbPath);
  try {
    await f.store.managed.saveConnection(
      f.principal,
      f.teamId,
      endpoint,
      'env-live',
    );
    const connect = () =>
      f.store.managed.connect(
        f.principal,
        f.teamId,
        f.agent.id,
        { providerId: 'isolated-dev', modelId: 'model-a' },
        WORKER_GRANT,
      );
    const issued = await connect();
    assert.ok(issued);
    const managed = issued.grant.id;
    const DAY = 86_400_000;
    /** Sets when a grant ends, as time passing would. */
    const endsIn = (grantId: string, days: number) =>
      raw
        .prepare('UPDATE agent_grants SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() + days * DAY).toISOString(), grantId);
    const daysLeft = async (grantId: string) =>
      (Date.parse(
        z
          .string()
          .parse(
            await raw
              .prepare('SELECT expires_at FROM agent_grants WHERE id = ?')
              .pluck()
              .get(grantId),
          ),
      ) -
        Date.now()) /
      DAY;
    const worker = async () => {
      const p = await f.store.agents.resolveToken(issued.token);
      return p.kind === 'agent' ? p.grantId : null;
    };
    // A fresh credential is left alone.
    assert.equal(
      await f.store.managed.renewWorkerGrants(WORKER_GRANT.lifetimeSeconds),
      0,
    );
    // Running out: the hub renews its own when it starts, and no other.
    await endsIn(managed, 1);
    await endsIn(f.grant.grant.id, 1);
    const restarted = await createApp(
      f.config,
      await f.open(),
      undefined,
      undefined,
      {},
      { feishu: standInFeishu },
    );
    await restarted.close();
    assert.ok((await daysLeft(managed)) > 89);
    assert.ok((await daysLeft(f.grant.grant.id)) < 2);
    assert.equal(await worker(), managed);
    // Ended while the hub was away: connecting again brings back the same
    // credential, so nothing frozen under it is stranded.
    await endsIn(managed, -1);
    await assert.rejects(worker);
    assert.equal(await connect(), null);
    assert.equal(await worker(), managed);
    assert.ok((await daysLeft(managed)) > 89);
    // Revocation is final: nothing renews it, and connecting issues another.
    await f.store.agents.revoke(f.principal, f.teamId, f.agent.id, managed);
    await endsIn(managed, 1);
    assert.equal(
      await f.store.managed.renewWorkerGrants(WORKER_GRANT.lifetimeSeconds),
      0,
    );
    await assert.rejects(worker);
    const replaced = await connect();
    assert.ok(replaced);
    assert.notEqual(replaced.grant.id, managed);
  } finally {
    await raw.close();
    await f.dispose();
  }
});

/** T3 elsewhere: its approval returns to the person's own loopback. */
const ISSUER = 'https://t3.test';
const STATE = 'a'.repeat(64);
const callbackUrl = (query: string) =>
  'http://127.0.0.1:49871/callback?' + query;
const valid = callbackUrl(
  `state=${STATE}&code=fixture-code&iss=${encodeURIComponent(ISSUER)}`,
);
/** A team-mode hub whose T3 completes only on the callback it is given. */
const teamMode = (): Partial<Omit<Hub, 'directory'>> => ({
  pasteCallback: true,
  authorize: async (_endpoint, interaction, signal) => {
    const { code } = await interaction.prepare(STATE, ISSUER, signal);
    await interaction.redirect(new URL(ISSUER + '/authorize?state=x'), signal);
    if ((await code) !== 'fixture-code') throw new Error('Wrong code');
    return credential;
  },
});

await test('in team mode a person finishes the T3 sign-in by pasting the address the approval opened', async () => {
  const f = await connectFixture(teamMode());
  try {
    const status = async () =>
      z
        .object({ signIn: z.string().nullable(), pasteCallback: z.boolean() })
        .loose()
        .parse((await f.call('GET', f.team + '/t3')).json<unknown>());
    assert.equal((await status()).pasteCallback, true);
    const started = await f.call('POST', f.team + '/t3/connect', {
      endpoint,
      replace: false,
    });
    assert.equal(started.statusCode, 200);
    assert.equal((await status()).signIn, 'waiting');
    const paste = (url: string) =>
      f.call('POST', f.team + '/t3/callback', { url });
    // Only this sign-in's exact address is taken.
    for (const wrong of [
      callbackUrl(
        `state=${'b'.repeat(64)}&code=fixture-code&iss=${encodeURIComponent(ISSUER)}`,
      ),
      callbackUrl(
        `state=${STATE}&code=fixture-code&iss=${encodeURIComponent('https://other.test')}`,
      ),
      valid.replace('127.0.0.1:49871', 'localhost:49871'),
      valid + '&extra=1',
      'not a url',
    ])
      assert.equal((await paste(wrong)).statusCode, 400, wrong);
    assert.equal((await status()).signIn, 'waiting');
    assert.equal((await paste(valid)).statusCode, 204);
    await settle(f);
    assert.equal(
      z
        .object({ connection: z.object({ endpoint: z.string() }) })
        .parse((await f.call('GET', f.team + '/t3')).json<unknown>()).connection
        .endpoint,
      endpoint,
    );
    // Used once: the same address does nothing now.
    assert.equal((await paste(valid)).statusCode, 409);
  } finally {
    await f.dispose();
  }
});

await test('in team mode T3 is reached over HTTPS: no T3 on the hub’s loopback is offered or taken', async () => {
  const f = await connectFixture(teamMode());
  try {
    assert.deepEqual(
      (await f.call('GET', f.team + '/t3/local')).json<unknown>(),
      { endpoint: null },
    );
    assert.equal(
      (
        await f.call('POST', f.team + '/t3/connect', {
          endpoint: 'http://127.0.0.1:3773/mcp',
          replace: false,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.dispose();
  }
});

/**
 * Proves a person can always sign in beside the deployment's session, to the
 * T3 the deployment connects and no other.
 */
await test('beside the deployment’s session a person signs in to the same T3', async () => {
  const f = await connectFixture({ provisioned: true });
  try {
    const status = z
      .object({ provisioned: z.boolean() })
      .loose()
      .parse((await f.call('GET', f.team + '/t3')).json<unknown>());
    assert.equal(status.provisioned, true);
    assert.deepEqual(
      (await f.call('GET', f.team + '/t3/local')).json<unknown>(),
      { endpoint: null },
    );
    // Before the deployment has connected T3 there is nothing to sign in to.
    const connect = (to: string) =>
      f.call('POST', f.team + '/t3/connect', { endpoint: to, replace: true });
    assert.equal((await connect(endpoint)).statusCode, 409);
    await f.store.managed.provision(endpoint, credential.environmentId);
    // Another T3 is refused; the deployment's is offered.
    assert.equal((await connect('https://other.test/mcp')).statusCode, 409);
    assert.equal((await connect(endpoint)).statusCode, 200);
    f.approve();
    await settle(f);
    assert.equal(
      loadCredential(t3AuthFile(f.directory), endpoint).client?.client_id,
      'kinmesh-test',
    );
  } finally {
    await f.dispose();
  }
});

const DAY = 86400_000;
/** The team's credential, as if T3 had issued it to end `in` from now. */
const ending = (after: number) => ({
  ...credential,
  expiresAt: new Date(Date.now() + after).toISOString(),
});

await test('from a week before T3’s sign-in ends every person is asked to reconnect, until someone does', async () => {
  let issued = ending(30 * DAY);
  const f = await connectFixture({
    authorize: async (_endpoint, interaction, signal) => {
      await interaction.redirect(
        new URL('https://t3.test/authorize?state=fixture'),
        signal,
      );
      return issued;
    },
  });
  try {
    const renewal = async (cookies = f.cookies) =>
      WorkspaceSnapshot.parse(
        (await f.app.inject({ url: '/api/workspace', cookies })).json(),
      ).attention.t3;
    const expired = async () =>
      z
        .object({ connection: z.object({ expired: z.boolean() }) })
        .parse((await f.call('GET', f.team + '/t3')).json<unknown>()).connection
        .expired;
    assert.equal(
      (
        await f.call('POST', f.team + '/t3/connect', {
          endpoint,
          replace: false,
        })
      ).statusCode,
      200,
    );
    await settle(f);
    // A month to go: nothing to do.
    assert.equal(await renewal(), null);
    // Eight days, then six: from a week before, it waits on everyone.
    saveCredential(t3AuthFile(f.directory), ending(8 * DAY));
    assert.equal(await renewal(), null);
    const soon = ending(6 * DAY);
    saveCredential(t3AuthFile(f.directory), soon);
    const colleague = await signInAs(f.app, 'colleague@example.com');
    for (const cookies of [f.cookies, colleague])
      assert.deepEqual(await renewal(cookies), {
        endpoint,
        expiresAt: soon.expiresAt,
        expired: false,
        fallback: null,
        pasteCallback: false,
        signIn: null,
      });
    assert.equal(await expired(), false);
    // Ended: still asked, and T3 reads as needing a new sign-in.
    saveCredential(t3AuthFile(f.directory), ending(-1000));
    assert.equal((await renewal())?.expired, true);
    assert.equal(await expired(), true);
    // Someone reconnects the same T3: under way, then answered by a new month.
    issued = ending(30 * DAY);
    assert.equal(
      (
        await f.call('POST', f.team + '/t3/connect', {
          endpoint,
          replace: true,
        })
      ).statusCode,
      200,
    );
    await settle(f);
    assert.equal(await renewal(), null);
    assert.equal(await expired(), false);
  } finally {
    await f.dispose();
  }
});

/** The deployment's session, Supervised, as the hub stores it. */
const deployment = (after: number) =>
  Credential.parse({
    endpoint,
    environmentId: credential.environmentId,
    tokens: { ...credential.tokens, access_token: 'deployment-access' },
    expiresAt: new Date(Date.now() + after).toISOString(),
    ceiling: 'approval-required',
  });
const T3Connection = z.object({
  connection: z.object({
    access: z.string().nullable(),
    ceiling: z.string().nullable(),
    expired: z.boolean(),
  }),
});

await test('the deployment renews its own T3 session: nobody is asked, and an ended one still reads as ended', async () => {
  const f = await connectFixture({ provisioned: true });
  try {
    await f.store.managed.provision(endpoint, credential.environmentId);
    saveCredential(t3DeploymentFile(f.directory), deployment(DAY));
    const snapshot = WorkspaceSnapshot.parse(
      (await f.call('GET', '/api/workspace')).json<unknown>(),
    );
    assert.equal(snapshot.attention.t3, null);
    saveCredential(t3DeploymentFile(f.directory), deployment(-1000));
    assert.equal(
      WorkspaceSnapshot.parse(
        (await f.call('GET', '/api/workspace')).json<unknown>(),
      ).attention.t3,
      null,
    );
    assert.equal(
      T3Connection.parse((await f.call('GET', f.team + '/t3')).json<unknown>())
        .connection.expired,
      true,
    );
  } finally {
    await f.dispose();
  }
});

/**
 * Proves the workspace says truthfully which mode agents' runs use when both
 * the deployment's session and a person's sign-in exist: the broader one,
 * the deployment's once the person's has ended, and that everyone is then
 * invited to sign in again while agents go on.
 */
await test('runs use a person’s broader sign-in, and the deployment’s session once it ends', async () => {
  const f = await connectFixture({ provisioned: true });
  try {
    await f.store.managed.provision(endpoint, credential.environmentId);
    const connection = async () =>
      T3Connection.parse((await f.call('GET', f.team + '/t3')).json<unknown>())
        .connection;
    const renewal = async () =>
      WorkspaceSnapshot.parse(
        (await f.call('GET', '/api/workspace')).json<unknown>(),
      ).attention.t3;
    // The deployment's session alone: Supervised.
    saveCredential(t3DeploymentFile(f.directory), deployment(30 * DAY));
    assert.deepEqual(await connection(), {
      access: 'operate',
      ceiling: 'approval-required',
      expired: false,
    });
    assert.equal(await renewal(), null);
    // A person signs in with Full access: that is what runs use.
    saveCredential(t3AuthFile(f.directory), {
      ...ending(30 * DAY),
      ceiling: 'full-access',
    });
    assert.deepEqual(await connection(), {
      access: 'operate',
      ceiling: 'full-access',
      expired: false,
    });
    // From a week before it ends everyone is invited to sign in again.
    saveCredential(t3AuthFile(f.directory), {
      ...ending(6 * DAY),
      ceiling: 'full-access',
    });
    assert.equal((await renewal())?.fallback, 'approval-required');
    // It ended: runs go on Supervised, nothing waits, and the invitation stays.
    saveCredential(t3AuthFile(f.directory), {
      ...ending(-1000),
      ceiling: 'full-access',
    });
    assert.deepEqual(await connection(), {
      access: 'operate',
      ceiling: 'approval-required',
      expired: false,
    });
    const ended = await renewal();
    assert.equal(ended?.expired, true);
    assert.equal(ended.fallback, 'approval-required');
  } finally {
    await f.dispose();
  }
});
