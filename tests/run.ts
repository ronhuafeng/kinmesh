import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import { startTestDatabase, startTestStore } from './database.js';

/**
 * `npm test`: one PostgreSQL and one store for the whole run, then `node --test` on the
 * given files, which inherit where it is.
 */
const [database, store] = await Promise.all([
  startTestDatabase(),
  startTestStore(),
]);
try {
  const child = spawn(
    process.execPath,
    // A test that never settles fails by name instead of stalling the run.
    [
      '--import',
      'tsx',
      '--test',
      '--test-timeout=120000',
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  const [code] = z
    .tuple([z.number().nullable(), z.string().nullable()])
    .parse(await once(child, 'exit'));
  process.exitCode = code ?? 1;
} finally {
  await Promise.all([database.stop(), store.stop()]);
}
