import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolveClose();
    });
  });
  return address.port;
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function stop(child: ChildProcess): Promise<void> {
  if (!running(child)) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(2000)]);
  if (running(child)) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

await test(
  'ordinary hub startup accepts private process environment without a local .env',
  { timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kinmesh-env-start-'));
    let child: ChildProcess | undefined;
    try {
      copyFileSync(resolve('package.json'), join(directory, 'package.json'));
      for (const name of ['src', 'node_modules', 'drizzle'])
        symlinkSync(resolve(name), join(directory, name), 'dir');
      const packageJson: unknown = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8'),
      );
      const packageFile = z
        .object({ scripts: z.object({ start: z.string() }) })
        .parse(packageJson);
      assert.equal(
        packageFile.scripts.start,
        'node --env-file-if-exists=.env --import tsx src/server/main.ts',
      );
      const port = await availablePort();
      const origin = 'http://127.0.0.1:' + String(port);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KINMESH_SETUP_TOKEN: randomBytes(32).toString('hex'),
        KINMESH_SESSION_KEY: randomBytes(32).toString('hex'),
        KINMESH_DATABASE: join(directory, 'team.sqlite'),
        KINMESH_ORIGIN: origin,
        KINMESH_PORT: String(port),
      };
      delete env.KINMESH_INBOX_CONFIG;
      child = spawn(
        process.execPath,
        [
          '--env-file-if-exists=.env',
          '--import',
          'tsx',
          'src/server/main.ts',
        ],
        { cwd: directory, env, stdio: 'ignore' },
      );
      let ready = false;
      const deadline = Date.now() + 18000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        try {
          const result = await fetch(origin + '/health', {
            signal: AbortSignal.timeout(700),
          });
          if (result.status === 200) {
            ready = true;
            break;
          }
        } catch {
          // Readiness is eventually consistent; no provider or native Run is used.
        }
        await delay(100);
      }
      assert.equal(ready, true, 'hub must start with environment-only secrets');
      const unauthenticated = await fetch(origin + '/api/me');
      assert.equal(unauthenticated.status, 401);
    } finally {
      if (child !== undefined) await stop(child);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
