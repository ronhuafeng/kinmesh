import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/persistence/store.js';
import { loadConfig } from '../src/server/config.js';
import { testDatabase, storeEnv } from './database.js';
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
  const filesEnv = storeEnv();
  const config = loadConfig({
    KINMESH_DATABASE_URL: database.url,
    KINMESH_STATE: directory,
    KINMESH_SESSION_KEY: randomBytes(32).toString('hex'),
    // Tests never ask the real GitHub: nothing listens on the discard port.
    KINMESH_GITHUB_API: 'http://127.0.0.1:9',
    ...feishuEnv,
    ...filesEnv,
  });
  return {
    directory,
    /** The store's settings, for another process of the same hub. */
    filesEnv,
    path: database.url,
    config,
    open: () => openStore(database.url),
    cleanup: async () => {
      await database.drop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
