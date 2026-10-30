import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.js';

await test('setup command creates private secrets, never prints values and refuses overwrite', () => {
  const f = fixture();
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
    const secret = /^KINMESH_SETUP_TOKEN=([a-f0-9]{64})$/m.exec(env)?.[1];
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
    f.cleanup();
  }
});
await test('actual server entrypoint listens, reports health, rejects anonymous API and shuts down', async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address !== null && typeof address !== 'string');
  const port = address.port;
  const closed = once(listener, 'close');
  listener.close();
  await closed;
  const f = fixture();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/server/main.ts'],
    {
      cwd: new URL('..', import.meta.url),
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH ?? '',
        KINMESH_DATABASE: f.path,
        KINMESH_SETUP_TOKEN: f.config.setupToken,
        KINMESH_SESSION_KEY: f.config.sessionKey.toString('hex'),
        KINMESH_PORT: String(port),
        KINMESH_ORIGIN: `http://127.0.0.1:${String(port)}`,
      },
    },
  );
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('Server exited before ready');
      }),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Server readiness timeout'));
        }, 10000);
        timer.unref();
      }),
    ]);
    const origin = `http://127.0.0.1:${String(port)}`;
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.equal((await fetch(origin + '/api/team')).status, 401);
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
    assert.equal(child.exitCode, 0);
    await assert.rejects(
      fetch(origin + '/health', { signal: AbortSignal.timeout(1000) }),
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    f.cleanup();
  }
});
