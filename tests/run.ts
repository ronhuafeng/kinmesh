import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import { startTestDatabase } from './database.js';

/**
 * `npm test`: one PostgreSQL for the whole run, then `node --test` on the
 * given files, which inherit where it is.
 */
const database = await startTestDatabase();
try {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--test', ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  const [code] = z
    .tuple([z.number().nullable(), z.string().nullable()])
    .parse(await once(child, 'exit'));
  process.exitCode = code ?? 1;
} finally {
  await database.stop();
}
