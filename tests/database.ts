import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
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

/** The S3-compatible store the hub keeps attachments in, as in deployment. */
export const SILO = 'pgsty/silo:RELEASE.2026-11-12T00-00-00Z';
const STORE = 'KINMESH_TEST_S3_ENDPOINT';
const STORE_USER = 'kinmesh';
const STORE_SECRET = 'kinmesh-test-secret';

/** One store for a whole test run, in a container the run starts and stops. */
export async function startTestStore() {
  const container = await new GenericContainer(SILO)
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_USER: STORE_USER,
      MINIO_ROOT_PASSWORD: STORE_SECRET,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .start();
  process.env[STORE] =
    `http://${container.getHost()}:${String(container.getMappedPort(9000))}`;
  return {
    stop: async () => {
      await container.stop();
    },
  };
}

/** What a hub, its worker and Team MCP need to reach the test store. */
export function storeEnv() {
  const endpoint = process.env[STORE];
  if (endpoint === undefined)
    throw new Error(
      `No test store: run tests through npm, which starts one (${STORE}).`,
    );
  return {
    KINMESH_S3_ENDPOINT: endpoint,
    // A bucket of its own: one test's removals never reach another's files.
    KINMESH_S3_BUCKET: `kinmesh-test-${randomUUID()}`,
    KINMESH_S3_ACCESS_KEY_ID: STORE_USER,
    KINMESH_S3_SECRET_ACCESS_KEY: STORE_SECRET,
  };
}
