import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
// Exclusive creation refuses to overwrite existing secrets. Never log the generated values.
try {
  // The password compose gives PostgreSQL, and the URL the hub reaches it by.
  const password = randomBytes(24).toString('hex');
  // The key compose gives the file store, and the hub reaches it with.
  const storeSecret = randomBytes(24).toString('hex');
  writeFileSync(
    '.env',
    `KINMESH_SESSION_KEY=${randomBytes(32).toString('hex')}\nKINMESH_POSTGRES_PASSWORD=${password}\nKINMESH_DATABASE_URL=postgres://kinmesh:${password}@127.0.0.1:5433/kinmesh\nKINMESH_S3_ENDPOINT=http://127.0.0.1:9000\nKINMESH_S3_ACCESS_KEY_ID=kinmesh\nKINMESH_S3_SECRET_ACCESS_KEY=${storeSecret}\nKINMESH_STATE=.store\nKINMESH_ORIGIN=http://127.0.0.1:3000\nKINMESH_PORT=3000\nFEISHU_APP_ID=\nFEISHU_APP_SECRET=\nKINMESH_EMAIL_DOMAIN=\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.info(
    'Created private .env; fill in the Feishu app and mailbox domain, then start PostgreSQL and the file store with `docker compose up -d postgres silo`. Existing files are never overwritten.',
  );
} catch {
  console.error(
    'Setup file not created; check whether .env already exists and directory is writable.',
  );
  process.exitCode = 1;
}
