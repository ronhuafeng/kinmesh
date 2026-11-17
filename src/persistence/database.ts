import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { z } from 'zod';
import * as schema from './schema.js';
import { DomainError } from '../domain/errors.js';

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

/** How a secret token is kept: never itself, only its SHA-256. */
export const digest = (token: string) =>
  createHash('sha256').update(token).digest('base64url');
/** Time as the database keeps it, in milliseconds, even mid-transaction. */
export const dbNow = sql<number>`(extract(epoch from clock_timestamp()) * 1000)::bigint`;

/** The channel every committed change is announced on (LISTEN/NOTIFY). */
export const CHANGES = 'kinmesh_changes';

/** Retried, since another transaction's commit only makes this one stale. */
const RETRY = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 20;

/** PostgreSQL's SQLSTATE, which drizzle carries as the cause of its own error. */
const codeOf = (error: unknown): string | undefined => {
  for (let at = error, depth = 0; at !== undefined && depth < 4; depth++) {
    const parsed = z
      .object({ code: z.string().optional(), cause: z.unknown().optional() })
      .safeParse(at);
    if (!parsed.success) return undefined;
    if (
      parsed.data.code !== undefined &&
      /^[0-9A-Z]{5}$/.test(parsed.data.code)
    )
      return parsed.data.code;
    at = parsed.data.cause;
  }
  return undefined;
};

/**
 * Runs reads of one transaction together, pipelined on its connection, and
 * waits for all of them before a failure is passed on, so none outlives the
 * transaction it belongs to.
 */
export async function together<T extends readonly unknown[]>(
  reads: readonly [...T],
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  await Promise.allSettled(reads);
  // All settled, the first failure in order is the one passed on.
  return Promise.all(reads);
}

/**
 * Whether a rule of the database refused the write: a check, a trigger or a
 * missing reference refuses the same write again. A duplicate key is left
 * out, since it may be a race lost to a concurrent transaction, which the
 * next attempt reads.
 */
export function refused(error: unknown) {
  const code = codeOf(error);
  return code !== undefined && code.startsWith('23') && code !== '23505';
}

/**
 * One store's connection to PostgreSQL. Every write runs in a serializable
 * transaction, retried when a concurrent one makes it stale, so the
 * compare-and-set rules hold as they did under a single writer. Within a
 * transaction every query, in any repository, runs on that transaction.
 */
export async function openDatabase(url: string) {
  /**
   * The transaction under way, and which read it is (`read`), null for a
   * write.
   */
  const current = new AsyncLocalStorage<{ tx: Tx; read: object | null }>();
  /** What `tally` counts, for the work it runs. */
  const tallies = new AsyncLocalStorage<{
    transactions: number;
    queries: number;
  }>();
  const client = postgres(DatabaseUrl.parse(url), {
    max: 10,
    onnotice: () => undefined,
  });
  const db = drizzle(client, {
    schema,
    logger: {
      logQuery: () => {
        const tally = tallies.getStore();
        if (tally && current.getStore()) tally.queries++;
      },
    },
  });
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
  const begin = () => {
    const tally = tallies.getStore();
    if (tally) tally.transactions++;
  };
  /** The transaction under way, or the pool. */
  const q = (): Query => current.getStore()?.tx ?? db;
  /**
   * Runs `action` atomically. Nested, it is a savepoint of the enclosing
   * transaction, or, within a read, simply part of it; at the top, a
   * serializable transaction, retried while concurrent ones make it stale.
   * Broken rules are conflicts.
   */
  async function atomic<T>(action: () => Promise<T>): Promise<T> {
    const outer = current.getStore();
    if (outer?.read) return action();
    try {
      if (outer !== undefined)
        return await outer.tx.transaction((tx) =>
          current.run({ tx, read: null }, action),
        );
      for (let attempt = 1; ; attempt++) {
        try {
          begin();
          return await db.transaction(
            (tx) => current.run({ tx, read: null }, action),
            { isolationLevel: 'serializable' },
          );
        } catch (error) {
          const code = codeOf(error);
          if (code === undefined || !RETRY.has(code) || attempt >= MAX_ATTEMPTS)
            throw error;
        }
      }
    } catch (error) {
      // An inner transaction's refusal is passed on as it is.
      if (!(error instanceof DomainError) && codeOf(error)?.startsWith('23'))
        throw new DomainError('conflict', { cause: error });
      throw error;
    }
  }
  /**
   * Runs `action` as one consistent read: a read-only, repeatable-read
   * transaction, so every query in it sees the same committed state, and
   * repository calls within it (`atomic`) are part of it rather than
   * transactions of their own. Within a write, it is part of that write.
   */
  async function read<T>(action: () => Promise<T>): Promise<T> {
    if (current.getStore() !== undefined) return action();
    begin();
    return db.transaction((tx) => current.run({ tx, read: {} }, action), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
  /**
   * `check`, asked once per read for the same arguments (named by `key`):
   * within a read every query sees the same state, so it finds the same
   * however many reads it guards. Outside a read it is asked every time.
   */
  function perRead<A extends unknown[], T>(
    key: (...args: A) => string,
    check: (...args: A) => Promise<T>,
  ) {
    const asked = new WeakMap<object, Map<string, Promise<T>>>();
    return (...args: A): Promise<T> => {
      const read = current.getStore()?.read;
      if (!read) return check(...args);
      const found = asked.get(read) ?? new Map<string, Promise<T>>();
      asked.set(read, found);
      const name = key(...args);
      const known = found.get(name);
      if (known !== undefined) return known;
      const answer = check(...args);
      found.set(name, answer);
      return answer;
    };
  }
  return {
    db,
    q,
    atomic,
    read,
    perRead,
    /**
     * How many transactions (top-level, reads and writes) `action` began,
     * and queries within them, for tests: only its own, never other work at
     * the time.
     */
    tally: async (action: () => Promise<unknown>) => {
      const tally = { transactions: 0, queries: 0 };
      await tallies.run(tally, action);
      return tally;
    },
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
      // A store closing first has already stopped listening.
      return () => listening.unlisten().catch(() => undefined);
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
