import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/persistence/store.js';
import { loadConfig } from '../src/server/config.js';
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'kinmesh-test-'));
  const path = join(directory, 'team.sqlite');
  const config = loadConfig({
    KINMESH_DATABASE: path,
    KINMESH_SETUP_TOKEN: randomBytes(32).toString('hex'),
    KINMESH_SESSION_KEY: randomBytes(32).toString('hex'),
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
