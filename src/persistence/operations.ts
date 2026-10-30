import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
});
export type Operation = z.infer<typeof Row>;
export function operationJournal(db: BetterSQLite3Database<typeof schema>) {
  const table = schema.executionOperations;
  function get(id: string) {
    return Row.parse(db.select().from(table).where(eq(table.id, id)).get());
  }
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
    claim(id: string) {
      return (
        db
          .update(table)
          .set({ phase: 'dispatching' })
          .where(and(eq(table.id, id), eq(table.phase, 'prepared')))
          .run().changes === 1
      );
    },
    uncertain(id: string) {
      db.update(table)
        .set({ phase: 'uncertain' })
        .where(and(eq(table.id, id), eq(table.phase, 'dispatching')))
        .run();
    },
    remember(id: string, reference: Reference) {
      db.update(table)
        .set({ reference: JSON.stringify(Reference.parse(reference)) })
        .where(eq(table.id, id))
        .run();
    },
    known(id: string, reference: Reference) {
      db.update(table)
        .set({
          phase: 'known',
          reference: JSON.stringify(Reference.parse(reference)),
        })
        .where(eq(table.id, id))
        .run();
    },
    rejected(id: string, kind: 'authentication' | 'permission') {
      db.update(table)
        .set({ phase: 'rejected', rejection: kind })
        .where(eq(table.id, id))
        .run();
    },
  };
}
export type OperationJournal = ReturnType<typeof operationJournal>;
