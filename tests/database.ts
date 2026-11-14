import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import {
  disposableDatabase,
  prepareTemplate,
} from '../src/persistence/disposable.js';

/** Where the test PostgreSQL is, once a run has started it. */
const ADMIN = 'KINMESH_TEST_DATABASE_ADMIN_URL';

/**
 * One PostgreSQL for a whole test run, in a container the run starts and
 * stops; its template holds the migrated schema every test copies.
 */
export async function startTestDatabase() {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('postgres')
    .withUsername('kinmesh')
    .withPassword('kinmesh-test')
    .start();
  const adminUrl = container.getConnectionUri();
  // A test waiting on a lock fails, naming where, instead of stalling the run.
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(
      "ALTER ROLE kinmesh SET lock_timeout = '20s'; ALTER ROLE kinmesh SET statement_timeout = '30s'",
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  await prepareTemplate(adminUrl);
  process.env[ADMIN] = adminUrl;
  return {
    adminUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

/** A fresh, migrated, empty database for one test; its URL and how to drop it. */
export function testDatabase() {
  const adminUrl = process.env[ADMIN];
  if (adminUrl === undefined)
    throw new Error(
      `No test PostgreSQL: run tests through npm, which starts one (${ADMIN}).`,
    );
  return disposableDatabase(adminUrl, 'test');
}
