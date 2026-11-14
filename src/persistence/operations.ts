import { createHash, randomUUID } from 'node:crypto';
import { and, eq, or, lte, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from './schema.js';
import { fingerprint } from './transactional.js';
import { dbNow as now, type Database } from './database.js';
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
/** The journal scope of one T3 environment behind one endpoint. */
export const executionScope = (endpoint: string, environmentId: string) =>
  fingerprint([endpoint, environmentId]);
export function operationJournal(d: Database) {
  const { q, atomic } = d;
  const table = schema.executionOperations;
  async function get(id: string) {
    const [row] = await q()
      .select()
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    return Row.parse(row);
  }
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
    async prepare(
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
      return atomic(async () => {
        await q()
          .insert(table)
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
          .onConflictDoNothing();
        const [found] = await q()
          .select()
          .from(table)
          .where(
            and(
              eq(table.scope, scope),
              eq(table.actor, intent.actor),
              eq(table.operationKey, intent.operationKey),
            ),
          )
          .limit(1);
        const row = Row.parse(found);
        if (row.fingerprint !== fingerprint)
          throw new ExecutionFailure('conflict');
        return row;
      });
    },
    get,
    // Recovery eligibility belongs in this CAS, not in a preceding (possibly stale) read.
    // One statement: a concurrent claimant waits for this one to commit, then
    // finds the phase changed and claims nothing.
    async claim(id: string, recover = false) {
      const [row] = await q()
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
        .returning();
      return row === undefined ? undefined : Claimed.parse(row);
    },
    async owned(row: ClaimedOperation) {
      const found = await q()
        .select({ id: table.id })
        .from(table)
        .where(fence(row))
        .limit(1);
      return found.length === 1;
    },
    async uncertain(row: ClaimedOperation) {
      const done = await q()
        .update(table)
        .set({ phase: 'uncertain', ...released })
        .where(fence(row));
      return done.count === 1;
    },
    async remember(row: ClaimedOperation, reference: Reference) {
      const done = await q()
        .update(table)
        .set({ reference: JSON.stringify(Reference.parse(reference)) })
        .where(fence(row));
      return done.count === 1;
    },
    async known(row: ClaimedOperation, reference: Reference) {
      const done = await q()
        .update(table)
        .set({
          phase: 'known',
          reference: JSON.stringify(Reference.parse(reference)),
          ...released,
        })
        .where(fence(row));
      return done.count === 1;
    },
    async rejected(
      row: ClaimedOperation,
      kind: 'authentication' | 'permission',
    ) {
      const done = await q()
        .update(table)
        .set({ phase: 'rejected', rejection: kind, ...released })
        .where(fence(row));
      return done.count === 1;
    },
  };
}
export type OperationJournal = ReturnType<typeof operationJournal>;
