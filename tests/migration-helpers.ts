import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';

/** Apply only the first `count` repository migrations, as an older release would have. */
export function migrateTo(
  raw: Database.Database,
  directory: string,
  count: number,
) {
  const folder = join(directory, `migrations-${String(count)}`);
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const journal = z
    .object({
      entries: z.array(z.object({ idx: z.number(), tag: z.string() }).loose()),
    })
    .loose()
    .parse(
      JSON.parse(
        readFileSync(
          new URL('../drizzle/meta/_journal.json', import.meta.url),
          'utf8',
        ),
      ),
    );
  const entries = journal.entries.filter((e) => e.idx < count);
  assert.equal(entries.length, count);
  writeFileSync(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const e of entries)
    copyFileSync(
      new URL('../drizzle/' + e.tag + '.sql', import.meta.url),
      join(folder, e.tag + '.sql'),
    );
  migrate(drizzle(raw), { migrationsFolder: folder });
}
