import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { z } from 'zod';
import * as schema from './schema.js';
import { IdentityError } from '../domain/agents.js';

/** A PostgreSQL connection URL. */
export const DatabaseUrl = z
  .url()
  .refine((value) => /^postgres(?:ql)?:$/.test(new URL(value).protocol), {
    message: 'A postgres:// URL is required',
  });

export type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** What a query runs on: the transaction under way, or the pool. */
export type Query = Db | Tx;

/** Time as the database keeps it, in milliseconds, even mid-transaction. */
export const dbNow = sql<number>`(extract(epoch from clock_timestamp()) * 1000)::bigint`;

/** The channel every committed change is announced on (LISTEN/NOTIFY). */
export const CHANGES = 'kinmesh_changes';

/** Retried, since another transaction's commit only makes this one stale. */
const RETRY = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 20;

const codeOf = (error: unknown): string | undefined => {
  const parsed = z.object({ code: z.string() }).safeParse(error);
  return parsed.success ? parsed.data.code : undefined;
};

/**
 * One store's connection to PostgreSQL. Every write runs in a serializable
 * transaction, retried when a concurrent one makes it stale, so the
 * compare-and-set rules hold as they did under a single writer. Within a
 * transaction every query, in any repository, runs on that transaction.
 */
export async function openDatabase(url: string) {
  const client = postgres(DatabaseUrl.parse(url), {
    max: 10,
    onnotice: () => undefined,
  });
  const db = drizzle(client, { schema });
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle', import.meta.url),
      ),
    });
  } catch (error) {
    await client.end({ timeout: 5 });
    throw error;
  }
  const current = new AsyncLocalStorage<Tx>();
  /** The transaction under way, or the pool. */
  const q = (): Query => current.getStore() ?? db;
  /**
   * Runs `action` atomically. Nested, it is a savepoint of the enclosing
   * transaction; at the top, a serializable transaction, retried while
   * concurrent ones make it stale. Broken rules are 409s.
   */
  async function atomic<T>(action: () => Promise<T>): Promise<T> {
    const outer = current.getStore();
    try {
      if (outer !== undefined)
        return await outer.transaction((tx) => current.run(tx, action));
      for (let attempt = 1; ; attempt++) {
        try {
          return await db.transaction((tx) => current.run(tx, action), {
            isolationLevel: 'serializable',
          });
        } catch (error) {
          const code = codeOf(error);
          if (code === undefined || !RETRY.has(code) || attempt >= MAX_ATTEMPTS)
            throw error;
        }
      }
    } catch (error) {
      if (codeOf(error)?.startsWith('23'))
        throw new IdentityError(409, { cause: error });
      throw error;
    }
  }
  return {
    db,
    q,
    atomic,
    /** Whether the database answers. */
    ready: async () => {
      try {
        await client`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    /**
     * Calls `listener` after any change another connection or process
     * commits; returns how to stop.
     */
    listen: async (listener: () => void) => {
      const listening = await client.listen(CHANGES, listener);
      return () => listening.unlisten();
    },
    /** Which database this is: its name and the identity it was created with. */
    identity: async () => {
      const [row] = await client<{ name: string; oid: string }[]>`
        select current_database() as name, oid::text as oid
        from pg_database where datname = current_database()`;
      if (row === undefined) throw new Error('Database identity unavailable');
      return { database: row.name, oid: row.oid };
    },
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
export type Database = Awaited<ReturnType<typeof openDatabase>>;
