import { snapshotPage } from './transactional.js';
import { sql } from 'drizzle-orm';
import * as s from './schema.js';

export const decode = (value: string): unknown => JSON.parse(value);
/** A message someone other than this person wrote. */
export const notMine = (humanId: string) =>
  sql`NOT (${s.messages.author}::jsonb @> ${JSON.stringify({ kind: 'human', humanId })}::jsonb)`;
export const now = () => new Date().toISOString();
/** Text to find as itself in a LIKE pattern: `%`, `_` and `\\` escaped. */
export const escapeLike = (text: string) =>
  text.replace(/[\\%_]/g, (c) => '\\' + c);
export const page = snapshotPage;
export const highest = (value: number | null | undefined) => value ?? 0;
