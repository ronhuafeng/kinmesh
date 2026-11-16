import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import { DomainError } from '../domain/errors.js';
import { PageInput, REACH, pageOf } from '../domain/communication.js';
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
      if (old.fingerprint !== digest) throw new DomainError('conflict');
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
const Older = z.strictObject({
  v: z.literal(2),
  context: z.string().max(1024),
  before: z.number().int().positive(),
});
/**
 * A list read from its newest end, for timelines that grow while they are
 * read (messages, tasks). The first page is the newest `limit` items; each
 * `nextCursor` reads the page of items older than the oldest one returned,
 * so newer items never shift an older page. Within a page, items run oldest
 * to newest.
 *
 * `reach`, a cursor this read issued earlier, widens the newest page back
 * through the page that cursor names, up to `REACH` items: a view that has
 * scrolled back keeps what it shows while new items arrive at the end.
 *
 * `select(before, floor, limit)` returns up to `limit` items, newest first,
 * with a position below `before` (when given) and at least `floor`.
 */
export async function latestPage<T extends { position: number }>(
  input: PageInput,
  context: unknown,
  schema: z.ZodType<T>,
  select: (before: number | null, floor: number, limit: number) => Promise<T[]>,
  reach?: string,
) {
  const parsed = PageInput.parse(input);
  const binding = JSON.stringify(context);
  const before = (raw: string) => {
    try {
      const cursor = Older.parse(
        decode(Buffer.from(raw, 'base64url').toString('utf8')),
      );
      if (cursor.context !== binding) throw new Error('Wrong cursor');
      return cursor.before;
    } catch {
      throw new DomainError('invalid');
    }
  };
  let floor = 0;
  let limit = parsed.limit;
  if (reach !== undefined) {
    const reached = await select(before(reach), 0, parsed.limit);
    floor = reached.at(-1)?.position ?? 0;
    limit = REACH;
  }
  const from = parsed.cursor === undefined ? null : before(parsed.cursor);
  const items = (await select(from, floor, limit)).reverse();
  const oldest = items[0];
  const nextCursor =
    oldest !== undefined && (await select(oldest.position, 0, 1)).length > 0
      ? Buffer.from(
          JSON.stringify({ v: 2, context: binding, before: oldest.position }),
        ).toString('base64url')
      : null;
  return z
    .strictObject({
      items: z.array(schema).max(REACH),
      nextCursor: z.string().nullable(),
    })
    .parse({ items, nextCursor });
}
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
      throw new DomainError('invalid');
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
