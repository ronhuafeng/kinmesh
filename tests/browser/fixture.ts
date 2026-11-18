import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deadline, freePort, printed, stop } from '../process-helpers.js';
import { feishuEnv } from '../helpers.js';
import { startFeishuStandIn } from '../feishu.js';
import { testDatabase, storeEnv } from '../database.js';
export const test = base.extend<{
  hub: { origin: string; database: string; state: string };
}>({
  hub: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'kinmesh-browser-'));
    chmodSync(dir, 0o700);
    const port = await freePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const feishu = await startFeishuStandIn();
    const database = await testDatabase();
    // Deliberate allowlist: no T3, Provider, Inbox, inherited .env or native credentials.
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/server/main.ts'],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          KINMESH_DATABASE_URL: database.url,
          KINMESH_STATE: dir,
          KINMESH_PORT: String(port),
          KINMESH_ORIGIN: origin,
          KINMESH_SESSION_KEY: randomBytes(32).toString('hex'),
          ...feishuEnv,
          ...storeEnv(),
          KINMESH_FEISHU_URL: feishu.url,
        },
      },
    );
    // The hub says it is ready once it listens: waiting for that spends none
    // of the address's request budget the tests' sign-ins need.
    const ready = printed(child, 'Kinmesh Team Hub ready');
    try {
      await deadline(ready, 20000, 'Disposable Kinmesh startup failed');
      await use({ origin, database: database.url, state: dir });
    } finally {
      await stop(child);
      await feishu.close();
      await database.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
export { expect };
