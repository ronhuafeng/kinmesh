import { ChannelView } from '../src/domain/communication.js';
import { key } from './communication-helpers.js';
import { z } from 'zod';
import { Team } from '../src/domain/contracts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { feishuEnv, fixture } from './helpers.js';
import { signInOver, startFeishuStandIn } from './feishu.js';
import { deadline, freePort, stop } from './process-helpers.js';

await test('setup command creates private secrets, never prints values and refuses overwrite', async () => {
  const f = await fixture();
  try {
    const script = new URL('../scripts/setup.ts', import.meta.url);
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
        script.pathname,
      ],
      { cwd: f.directory, encoding: 'utf8' },
    );
    const env = readFileSync(join(f.directory, '.env'), 'utf8');
    assert.equal(statSync(join(f.directory, '.env')).mode & 0o777, 0o600);
    const secret = /^KINMESH_SESSION_KEY=([a-f0-9]{64})$/m.exec(env)?.[1];
    assert.ok(secret);
    assert.ok(!output.includes(secret));
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          '--import',
          new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
          script.pathname,
        ],
        { cwd: f.directory, stdio: 'ignore' },
      ),
    );
    assert.equal(readFileSync(join(f.directory, '.env'), 'utf8'), env);
  } finally {
    await f.cleanup();
  }
});
// Unique to the spawned entrypoint: env boot, graceful exit and durable state
// across a real restart. Route behavior lives in server/agents/communication/tasks tests.
await test('actual server entrypoint boots from env, persists an authenticated write and serves it after restart', async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const f = await fixture();
  const feishu = await startFeishuStandIn();
  const start = () =>
    spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
      cwd: new URL('..', import.meta.url),
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH ?? '',
        KINMESH_DATABASE_URL: f.path,
        KINMESH_STATE: f.directory,
        KINMESH_SESSION_KEY: f.config.sessionKey.toString('hex'),
        ...feishuEnv,
        KINMESH_FEISHU_URL: feishu.url,
        KINMESH_PORT: String(port),
        KINMESH_ORIGIN: origin,
      },
    });
  let child = start();
  const ready = () =>
    deadline(
      Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => {
          throw new Error('Server exited before ready');
        }),
      ]),
      10000,
      'Server readiness timeout',
    );
  const shutdown = async () => {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
    assert.equal(child.exitCode, 0);
  };
  try {
    await ready();
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.equal((await fetch(origin + '/api/team')).status, 401);
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    // Signing in through (a stand-in for) Feishu's own hosts.
    const cookie = await signInOver(origin, 'owner@example.com');
    const team = z
      .object({ team: Team })
      .parse(
        await (
          await fetch(origin + '/api/team', { headers: { cookie } })
        ).json(),
      ).team;
    const created = await post(
      `/api/teams/${team.id}/channels`,
      { operationKey: key(), name: 'HTTP discussion' },
      { cookie },
    );
    assert.equal(created.status, 201);
    const channel = ChannelView.parse(await created.json());
    await shutdown();
    await assert.rejects(
      fetch(origin + '/health', { signal: AbortSignal.timeout(1000) }),
    );
    child = start();
    await ready();
    // The env session key survives the restart, so the same cookie still reads it back.
    const recovered = await fetch(
      `${origin}/api/teams/${team.id}/channels/${channel.id}`,
      { headers: { cookie } },
    );
    assert.equal(recovered.status, 200);
    const read = ChannelView.parse(await recovered.json());
    assert.equal(read.id, channel.id);
    assert.equal(read.name, 'HTTP discussion');
    await shutdown();
  } finally {
    await stop(child, 'SIGKILL');
    await feishu.close();
    await f.cleanup();
  }
});
