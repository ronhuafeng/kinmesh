import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from './schema.js';
import { IdentityError } from '../domain/agents.js';
import { PageInput, pageOf } from '../domain/communication.js';
const decode = (value: string): unknown => JSON.parse(value);
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function transactional(db: BetterSQLite3Database<typeof s>) {
  function atomic<T>(action: () => T): T {
    try {
      return db.transaction(action, { behavior: 'immediate' });
    } catch (error) {
      const code = z.object({ code: z.string() }).safeParse(error);
      if (code.success && code.data.code.startsWith('SQLITE_CONSTRAINT'))
        throw new IdentityError(409);
      throw error;
    }
  }
  function receipt<T>(
    scope: string,
    operationKey: string,
    input: unknown,
    schema: z.ZodType<T>,
    effect: () => T,
  ): T {
    const digest = fingerprint(input);
    const old = db
      .select()
      .from(s.communicationOperations)
      .where(
        and(
          eq(s.communicationOperations.scope, scope),
          eq(s.communicationOperations.operationKey, operationKey),
        ),
      )
      .get();
    if (old !== undefined) {
      if (old.fingerprint !== digest) throw new IdentityError(409);
      return schema.parse(decode(old.result));
    }
    const result = schema.parse(effect());
    db.insert(s.communicationOperations)
      .values({
        scope,
        operationKey,
        fingerprint: digest,
        result: JSON.stringify(result),
      })
      .run();
    return result;
  }
  return { atomic, receipt };
}
const Cursor = z
  .strictObject({
    v: z.literal(1),
    context: z.string().max(1024),
    after: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  })
  .refine((v) => v.after <= v.max);
export function snapshotPage<T extends { position: number }>(
  input: PageInput,
  context: unknown,
  schema: z.ZodType<T>,
  high: () => number,
  select: (after: number, max: number, limit: number) => T[],
) {
  const parsed = PageInput.parse(input);
  const binding = JSON.stringify(context);
  let after = 0;
  let maximum: number;
  if (parsed.cursor === undefined) maximum = high();
  else {
    try {
      const cursor = Cursor.parse(
        decode(Buffer.from(parsed.cursor, 'base64url').toString('utf8')),
      );
      if (cursor.context !== binding) throw new Error('Wrong cursor');
      after = cursor.after;
      maximum = cursor.max;
    } catch {
      throw new IdentityError(400);
    }
  }
  const rows = select(after, maximum, parsed.limit + 1);
  const items = rows.slice(0, parsed.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > parsed.limit && last !== undefined
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            context: binding,
            after: last.position,
            max: maximum,
          }),
        ).toString('base64url')
      : null;
  return pageOf(schema).parse({ items, nextCursor });
}
