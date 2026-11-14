import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/persistence/store.js';
import { loadConfig } from '../src/server/config.js';
/** A Feishu app for tests; its hosts are stood in for. */
export const feishuEnv = {
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'test-secret',
  KINMESH_EMAIL_DOMAIN: 'example.com',
};
export function fixture() {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'kinmesh-test-'));
  const path = join(directory, 'team.sqlite');
  const config = loadConfig({
    KINMESH_DATABASE: path,
    KINMESH_SESSION_KEY: randomBytes(32).toString('hex'),
    ...feishuEnv,
  });
  return {
    directory,
    path,
    config,
    open: () => openStore(path),
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
