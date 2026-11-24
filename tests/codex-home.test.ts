import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { spaceServer } from '../deploy/t3/space.js';
import { createApp } from '../src/server/app.js';
import { TEAM_MCP_GRANT } from '../src/server/connect.js';
import { agentFixture } from './agent-helpers.js';
import { standInFeishu } from './feishu.js';
import { rawDatabase } from './raw.js';

const TEAM_MCP = 'http://127.0.0.1:3001/mcp';
/** The Team MCP credential an agent's Codex home holds. */
const credentialIn = (home: string) =>
  /Authorization = "Bearer ([^"]+)"/.exec(
    readFileSync(join(home, 'config.toml'), 'utf8'),
  )?.[1] ?? null;

/**
 * Proves an agent connected from the workspace gets its Codex home beside
 * T3 written through the provisioner, so nobody copies a credential: the
 * home holds a Team MCP credential that acts as the agent, never shown to
 * the browser; connecting again replaces it and revokes the old one; the
 * hub renews it like the worker's; disconnecting revokes it; and when the
 * home cannot be written, no credential is left behind.
 */
await test('connecting an agent writes its Codex home beside T3, with a credential only the home holds', async () => {
  const f = await agentFixture();
  const raw = rawDatabase(f.dbPath);
  const dir = mkdtempSync(join(tmpdir(), 'kinmesh-codex-'));
  const tokenFile = join(dir, 'space-token');
  writeFileSync(tokenFile, 'space-secret\n', { mode: 0o600 });
  mkdirSync(join(dir, 'space'));
  const provisioner = spaceServer({
    space: join(dir, 'space'),
    token: 'space-secret',
    t3: 'unused',
    agents: join(dir, 'agents'),
    codexAuth: null,
  });
  provisioner.listen(0, '127.0.0.1');
  await once(provisioner, 'listening');
  const address = provisioner.address();
  assert.ok(address !== null && typeof address === 'object');
  const app = await createApp(
    {
      ...f.config,
      space: {
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        tokenFile,
      },
      teamMcpUrl: TEAM_MCP,
    },
    f.store,
    undefined,
    undefined,
    { ensureWorker: () => Promise.resolve() },
    { feishu: standInFeishu },
  );
  const agentPath = `/api/teams/${f.teamId}/agents/${f.agent.id}`;
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      cookies: f.cookies,
      ...(payload ? { payload } : {}),
    });
  const connect = () =>
    call('POST', agentPath + '/connect', {
      providerId: 'kinmesh_ada',
      modelId: 'gpt-test',
    });
  const actsAs = async (token: string | null) => {
    assert.ok(token);
    const p = await f.store.agents.resolveToken(token);
    return p.kind === 'agent' ? p.agentId : null;
  };
  try {
    await f.store.t3Connections.saveConnection(
      f.principal,
      f.teamId,
      'https://t3.test/mcp',
      'env-live',
    );
    // Where its home is, for its T3 provider, before anything is written.
    const home = join(dir, 'agents', f.agent.id, 'codex');
    const asked = await call('GET', agentPath + '/codex');
    assert.equal(asked.statusCode, 200);
    assert.deepEqual(asked.json(), { home });
    const first = await connect();
    assert.equal(first.statusCode, 200);
    assert.doesNotMatch(first.body, /kma_/);
    const firstToken = credentialIn(home);
    assert.equal(await actsAs(firstToken), f.agent.id);
    assert.match(
      readFileSync(join(home, 'config.toml'), 'utf8'),
      new RegExp(`^url = "${TEAM_MCP}"$`, 'm'),
    );
    // Connecting again: a new credential, and the old one no longer works.
    assert.equal((await connect()).statusCode, 200);
    const secondToken = credentialIn(home);
    assert.notEqual(secondToken, firstToken);
    assert.equal(await actsAs(secondToken), f.agent.id);
    await assert.rejects(actsAs(firstToken));
    // The hub renews it while it serves the agent, as it does the worker's.
    const Grants = z.object({
      grants: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          revokedAt: z.string().nullable(),
        }),
      ),
    });
    const live = async () =>
      Grants.parse(
        (await call('GET', agentPath + '/grants')).json(),
      ).grants.filter(
        (g) => g.label === TEAM_MCP_GRANT.label && g.revokedAt === null,
      );
    const [kept] = await live();
    assert.ok(kept);
    assert.equal((await live()).length, 1);
    await raw
      .prepare('UPDATE agent_grants SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() + 86_400_000).toISOString(), kept.id);
    assert.equal(
      await f.store.managed.renewWorkerGrants(TEAM_MCP_GRANT.lifetimeSeconds),
      1,
    );
    // Disconnecting revokes it with the worker's.
    assert.equal(
      (await call('POST', agentPath + '/disconnect')).statusCode,
      204,
    );
    await assert.rejects(actsAs(secondToken));
    // Without the provisioner, connecting says so and keeps no credential.
    provisioner.close();
    const unwritten = await connect();
    assert.equal(unwritten.statusCode, 503);
    assert.deepEqual(await live(), []);
  } finally {
    provisioner.close();
    await app.close();
    await raw.close();
    await f.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
