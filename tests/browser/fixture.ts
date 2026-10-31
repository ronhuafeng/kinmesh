import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
export const test = base.extend<{
  hub: { origin: string; setup: string; database: string };
}>({
  hub: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'kinmesh-browser-'));
    chmodSync(dir, 0o700);
    const socket = createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, '127.0.0.1', resolve),
    );
    const address = socket.address();
    if (!address || typeof address === 'string')
      throw new Error('Loopback port unavailable');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    const origin = `http://127.0.0.1:${String(port)}`;
    const setup = randomBytes(32).toString('hex');
    // Deliberate allowlist: no T3, Provider, Inbox, inherited .env or native credentials.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server/main.ts'],
      {
        cwd: process.cwd(),
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          KINMESH_DATABASE: join(dir, 'team.sqlite'),
          KINMESH_PORT: String(port),
          KINMESH_ORIGIN: origin,
          KINMESH_SETUP_TOKEN: setup,
          KINMESH_SESSION_KEY: randomBytes(32).toString('hex'),
        },
      },
    );
    const exit = new Promise<void>((resolve) =>
      child.once('exit', () => {
        resolve();
      }),
    );
    try {
      let ready = false;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const response = await fetch(origin + '/health', {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* bounded startup polling */
        }
        await delay(100);
      }
      if (!ready) throw new Error('Disposable Kinmesh startup failed');
      await use({ origin, setup, database: join(dir, 'team.sqlite') });
    } finally {
      child.kill('SIGTERM');
      const graceful = await Promise.race([
        exit.then(() => true),
        delay(5000).then(() => false),
      ]);
      if (!graceful) {
        child.kill('SIGKILL');
        await exit;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
export { expect };
