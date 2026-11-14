import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { DatabaseUrl, openDatabase } from './database.js';

/** Databases made to be thrown away: by tests, and by the live gates. */
const DISPOSABLE = /^kinmesh_(?:test|live)_[a-f0-9]{16}$/;
const TEMPLATE = 'kinmesh_template';

const named = (adminUrl: string, database: string) => {
  const url = new URL(adminUrl);
  url.pathname = '/' + database;
  return url.href;
};
/** Whether a connection URL names a database made to be thrown away. */
export const isDisposable = (url: string) =>
  DISPOSABLE.test(new URL(url).pathname.slice(1));
/** A live gate's database: one made to be thrown away, never a team's. */
export const LiveDatabaseUrl = DatabaseUrl.refine(isDisposable, {
  message: 'A disposable kinmesh_live_ database is required',
});

/**
 * Makes the migrated template that disposable databases are copied from. Run
 * once, before any copy; nothing else may be connected to it while copying.
 */
export async function prepareTemplate(adminUrl: string) {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const template = await openDatabase(named(adminUrl, TEMPLATE));
  await template.close();
}

/**
 * A new, empty database; its URL, and how to drop it. A test's is copied from
 * the migrated template; a live gate's is migrated when the store first opens it.
 */
export async function disposableDatabase(
  adminUrl: string,
  kind: 'test' | 'live',
) {
  const name = `kinmesh_${kind}_${randomBytes(8).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    // Copies queue behind each other on the template; one only fails when
    // another holds it at that instant.
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.unsafe(
          kind === 'test'
            ? `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`
            : `CREATE DATABASE ${name}`,
        );
        break;
      } catch (error) {
        const busy =
          error instanceof Error && 'code' in error && error.code === '55006';
        if (!busy || attempt >= 50) throw error;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = named(adminUrl, name);
  return { url, drop: () => dropDisposable(adminUrl, url) };
}

/** Drops a disposable database and its connections; refuses any other. */
export async function dropDisposable(adminUrl: string, url: string) {
  if (!isDisposable(url))
    throw new Error('Only a disposable database is dropped');
  const name = new URL(url).pathname.slice(1);
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
