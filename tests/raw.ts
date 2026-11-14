import postgres from 'postgres';

/** `?` placeholders, as the tests write them, numbered as PostgreSQL wants. */
const numbered = (text: string) => {
  let n = 0;
  return text.replace(/\?/g, () => `$${String(++n)}`);
};
type Value = string | number | boolean | null | Buffer;

/**
 * Direct SQL on a test's database, for what the store must never do:
 * corrupting state, or proving a rule holds below the code. Each call
 * answers with a promise. `foreign_keys = OFF` lets a test write past
 * references and rules, as an operator's repair would.
 */
export function rawDatabase(url: string) {
  const sql = postgres(url, {
    max: 1,
    onnotice: () => undefined,
    // Counters and millisecond times come back as numbers, as the store reads them.
    types: {
      int8: {
        to: 20,
        from: [20],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });
  const run = async (text: string, values: Value[]) => {
    const result = await sql.unsafe(
      numbered(text),
      values as postgres.ParameterOrJSON<never>[],
    );
    return {
      rows: [...result] as Record<string, unknown>[],
      count: result.count,
    };
  };
  const first = (row: Record<string, unknown> | undefined) =>
    row === undefined ? undefined : Object.values(row)[0];
  return {
    prepare(text: string) {
      return {
        run: async (...values: Value[]) => ({
          changes: (await run(text, values)).count,
        }),
        get: async (...values: Value[]) => (await run(text, values)).rows[0],
        all: async (...values: Value[]) => (await run(text, values)).rows,
        pluck: () => ({
          get: async (...values: Value[]) =>
            first((await run(text, values)).rows[0]),
          all: async (...values: Value[]) =>
            (await run(text, values)).rows.map(first),
        }),
      };
    },
    exec: async (text: string) => {
      await sql.unsafe(text);
    },
    /**
     * Runs `body` (PL/pgSQL) before each insert into `table`, `when` it
     * holds: by default refusing it, as the schema's own rules refuse a
     * write (SQLSTATE 23000), for a test to break a write part-way.
     */
    trigger: async (
      name: string,
      table: string,
      body = "RAISE EXCEPTION 'fixture' USING ERRCODE = '23000';",
      when?: string,
    ) => {
      await sql.unsafe(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`,
      );
      await sql.unsafe(
        `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW ${when ? `WHEN (${when}) ` : ''}EXECUTE FUNCTION ${name}()`,
      );
    },
    /** Removes a trigger made with `trigger`. */
    dropTrigger: async (name: string, table: string) => {
      await sql.unsafe(`DROP TRIGGER ${name} ON ${table}`);
      await sql.unsafe(`DROP FUNCTION ${name}()`);
    },
    pragma: async (setting: string) => {
      if (/^foreign_keys\s*=\s*OFF$/i.test(setting))
        await sql.unsafe('SET session_replication_role = replica');
      else if (/^foreign_keys\s*=\s*ON$/i.test(setting))
        await sql.unsafe('SET session_replication_role = origin');
      else throw new Error(`No PostgreSQL equivalent for pragma ${setting}`);
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
export type RawDatabase = ReturnType<typeof rawDatabase>;
