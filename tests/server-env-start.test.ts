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
import { z } from 'zod';
import { deadline, freePort, printed, stop } from './process-helpers.js';
import { feishuEnv } from './helpers.js';
import { testDatabase } from './database.js';

/**
 * Proves the hub's start script runs on secrets from the process environment
 * alone, with no .env file, and still refuses an unauthenticated request.
 */
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
        { cwd: directory, env, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      // It says when it is ready, and then answers ready: no polling spends
      // the address's request budget.
      await deadline(
        printed(child, 'Kinmesh Team Hub ready'),
        18000,
        'hub must start with environment-only secrets',
      );
      assert.equal((await fetch(origin + '/health')).status, 200);
      const unauthenticated = await fetch(origin + '/api/me');
      assert.equal(unauthenticated.status, 401);
    } finally {
      if (child !== undefined) await stop(child, 'SIGTERM', 2000);
      await database.drop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
