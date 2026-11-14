import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { freePort, stop } from './process-helpers.js';
import { feishuEnv } from './helpers.js';
import { testDatabase } from './database.js';

await test(
  'ordinary hub startup accepts private process environment without a local .env',
  { timeout: 30000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kinmesh-env-start-'));
    const database = await testDatabase();
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
      const port = await freePort();
      const origin = 'http://127.0.0.1:' + String(port);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KINMESH_SESSION_KEY: randomBytes(32).toString('hex'),
        ...feishuEnv,
        KINMESH_DATABASE_URL: database.url,
        KINMESH_STATE: directory,
        KINMESH_ORIGIN: origin,
        KINMESH_PORT: String(port),
      };
      delete env.KINMESH_INBOX_CONFIG;
      child = spawn(
        process.execPath,
        ['--env-file-if-exists=.env', '--import', 'tsx', 'src/server/main.ts'],
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
      if (child !== undefined) await stop(child, 'SIGTERM', 2000);
      await database.drop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
