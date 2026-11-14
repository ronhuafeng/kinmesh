import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/persistence/store.js';
import { loadConfig } from '../src/server/config.js';
import { testDatabase } from './database.js';
/** A Feishu app for tests; its hosts are stood in for. */
export const feishuEnv = {
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'test-secret',
  KINMESH_EMAIL_DOMAIN: 'example.com',
};
/**
 * A test's own database, copied from the migrated template, and its own
 * state directory. `path` is the database's URL.
 */
export async function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'kinmesh-test-'));
  const database = await testDatabase();
  const config = loadConfig({
    KINMESH_DATABASE_URL: database.url,
    KINMESH_STATE: directory,
    KINMESH_SESSION_KEY: randomBytes(32).toString('hex'),
    ...feishuEnv,
  });
  return {
    directory,
    path: database.url,
    config,
    open: () => openStore(database.url),
    cleanup: async () => {
      await database.drop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
