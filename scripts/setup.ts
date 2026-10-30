import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
// Exclusive creation refuses to overwrite existing secrets. Never log the generated values.
try {
  writeFileSync(
    '.env',
    `KINMESH_SETUP_TOKEN=${randomBytes(32).toString('hex')}\nKINMESH_SESSION_KEY=${randomBytes(32).toString('hex')}\nKINMESH_DATABASE=.store/kinmesh.sqlite\nKINMESH_ORIGIN=http://127.0.0.1:3000\nKINMESH_PORT=3000\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.info(
    'Created private .env; use its setup credential locally. Existing files are never overwritten.',
  );
} catch {
  console.error(
    'Setup file not created; check whether .env already exists and directory is writable.',
  );
  process.exitCode = 1;
}
