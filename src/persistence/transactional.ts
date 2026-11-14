import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import { IdentityError } from '../domain/agents.js';
import { PageInput, pageOf } from '../domain/communication.js';
import type { Reference } from '../domain/execution.js';
import type { Database } from './database.js';
const decode = (value: string): unknown => JSON.parse(value);
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The persisted key of one native execution (thread, or exact run). */
export const referenceKey = (ref: Reference) =>
  fingerprint([
    ref.backend,
    ref.environmentId,
    ref.threadId,
    ref.runId ?? null,
  ]);
export function transactional(d: Database) {
  const { q, atomic } = d;
  /**
   * An idempotent effect: the first call with an operation key runs it and
   * keeps its result; a retry replays that result; the same key with other
   * input is refused. Run inside `atomic`.
   */
  async function receipt<T>(
    scope: string,
    operationKey: string,
    input: unknown,
    schema: z.ZodType<T>,
    effect: () => Promise<T>,
  ): Promise<T> {
    const digest = fingerprint(input);
    const [old] = await q()
      .select()
      .from(s.communicationOperations)
      .where(
        and(
          eq(s.communicationOperations.scope, scope),
          eq(s.communicationOperations.operationKey, operationKey),
        ),
      )
      .limit(1);
    if (old !== undefined) {
      if (old.fingerprint !== digest) throw new IdentityError(409);
      return schema.parse(decode(old.result));
    }
    const result = schema.parse(await effect());
    await q()
      .insert(s.communicationOperations)
      .values({
        scope,
        operationKey,
        fingerprint: digest,
        result: JSON.stringify(result),
      });
    return result;
  }
  return { q, atomic, receipt };
}
const Cursor = z
  .strictObject({
    v: z.literal(1),
    context: z.string().max(1024),
    after: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  })
  .refine((v) => v.after <= v.max);
export async function snapshotPage<T extends { position: number }>(
  input: PageInput,
  context: unknown,
  schema: z.ZodType<T>,
  high: () => Promise<number>,
  select: (after: number, max: number, limit: number) => Promise<T[]>,
) {
  const parsed = PageInput.parse(input);
  const binding = JSON.stringify(context);
  let after = 0;
  let maximum: number;
  if (parsed.cursor === undefined) maximum = await high();
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
  const rows = await select(after, maximum, parsed.limit + 1);
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
