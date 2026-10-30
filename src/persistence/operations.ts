import { createHash, randomUUID } from 'node:crypto';
import { and, eq, or, lte, gt, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as schema from './schema.js';
import { Reference, Intent, ExecutionFailure } from '../domain/execution.js';

const Row = z.object({
  id: z.string(),
  scope: z.string(),
  actor: z.string(),
  operationKey: z.string(),
  requestId: z.string(),
  fingerprint: z.string(),
  tool: z.string(),
  payload: z.string(),
  phase: z.enum(['prepared', 'dispatching', 'uncertain', 'known', 'rejected']),
  reference: z.string().nullable(),
  rejection: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  claimToken: z.string().nullable(),
  leaseUntil: z.number().int().nonnegative(),
});
export type Operation = z.infer<typeof Row>;
const Claimed = Row.extend({
  claimToken: z.uuid(),
  leaseUntil: z.number().int().positive(),
});
export type ClaimedOperation = z.infer<typeof Claimed>;
// SDK mutations default to 30s; an entire attempt is capped at 60s. No lease renewal.
export const EXECUTION_LEASE_MS = 120_000;
export const EXECUTION_ATTEMPT_MS = 60_000;
export function operationJournal(db: BetterSQLite3Database<typeof schema>) {
  const table = schema.executionOperations;
  function get(id: string) {
    return Row.parse(db.select().from(table).where(eq(table.id, id)).get());
  }
  // Evaluate expiry inside SQLite, including after waiting for another writer.
  const now = sql`cast(unixepoch('subsec') * 1000 as integer)`;
  function fence(row: ClaimedOperation) {
    return and(
      eq(table.id, row.id),
      eq(table.phase, 'dispatching'),
      eq(table.generation, row.generation),
      eq(table.claimToken, row.claimToken),
      gt(table.leaseUntil, now),
    );
  }
  const released = { claimToken: null, leaseUntil: 0 };
  return {
    prepare(
      scope: string,
      intent: Intent,
      tool: string,
      payload: Record<string, unknown>,
      authority: string,
    ) {
      Intent.parse(intent);
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ tool, payload, authority }))
        .digest('hex');
      return db.transaction(
        (tx) => {
          tx.insert(table)
            .values({
              id: randomUUID(),
              scope,
              ...intent,
              requestId: randomUUID(),
              fingerprint,
              tool,
              payload: JSON.stringify(payload),
              phase: 'prepared',
            })
            .onConflictDoNothing()
            .run();
          const row = Row.parse(
            tx
              .select()
              .from(table)
              .where(
                and(
                  eq(table.scope, scope),
                  eq(table.actor, intent.actor),
                  eq(table.operationKey, intent.operationKey),
                ),
              )
              .get(),
          );
          if (row.fingerprint !== fingerprint)
            throw new ExecutionFailure('conflict');
          return row;
        },
        { behavior: 'immediate' },
      );
    },
    get,
    // Recovery eligibility belongs in this CAS, not in a preceding (possibly stale) read.
    claim(id: string, recover = false) {
      const row = db
        .update(table)
        .set({
          phase: 'dispatching',
          generation: sql`${table.generation}+1`,
          claimToken: randomUUID(),
          leaseUntil: sql`${now} + ${EXECUTION_LEASE_MS}`,
        })
        .where(
          and(
            eq(table.id, id),
            recover
              ? or(
                  eq(table.phase, 'prepared'),
                  eq(table.phase, 'uncertain'),
                  and(
                    eq(table.phase, 'dispatching'),
                    lte(table.leaseUntil, now),
                  ),
                )
              : eq(table.phase, 'prepared'),
          ),
        )
        .returning()
        .all()[0];
      return row === undefined ? undefined : Claimed.parse(row);
    },
    owned(row: ClaimedOperation) {
      return (
        db.select({ id: table.id }).from(table).where(fence(row)).get() !==
        undefined
      );
    },
    uncertain(row: ClaimedOperation) {
      return (
        db
          .update(table)
          .set({ phase: 'uncertain', ...released })
          .where(fence(row))
          .run().changes === 1
      );
    },
    remember(row: ClaimedOperation, reference: Reference) {
      return (
        db
          .update(table)
          .set({ reference: JSON.stringify(Reference.parse(reference)) })
          .where(fence(row))
          .run().changes === 1
      );
    },
    known(row: ClaimedOperation, reference: Reference) {
      return (
        db
          .update(table)
          .set({
            phase: 'known',
            reference: JSON.stringify(Reference.parse(reference)),
            ...released,
          })
          .where(fence(row))
          .run().changes === 1
      );
    },
    rejected(row: ClaimedOperation, kind: 'authentication' | 'permission') {
      return (
        db
          .update(table)
          .set({ phase: 'rejected', rejection: kind, ...released })
          .where(fence(row))
          .run().changes === 1
      );
    },
  };
}
export type OperationJournal = ReturnType<typeof operationJournal>;
