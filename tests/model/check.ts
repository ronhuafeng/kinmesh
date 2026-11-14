import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm run model:inbox`: model-checks the Inbox protocol (Inbox.tla). Each
 * configuration without a bug must pass every property it names; each
 * known-bad variant (MCInbox.<bug>.cfg) must break exactly the property it
 * names, which shows that property can fail at all. Needs Java 11+ and TLA2TOOLS, the path to
 * tla2tools.jar (TLA+ tools 1.8.0).
 */
const here = dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLA2TOOLS;
if (!jar) {
  console.error('Set TLA2TOOLS to the path of tla2tools.jar.');
  process.exit(2);
}
const java = process.env.TLA_JAVA ?? 'java';

function check(config: string) {
  const meta = mkdtempSync(join(tmpdir(), 'kinmesh-tlc-'));
  try {
    const run = spawnSync(
      java,
      [
        '-XX:+UseParallelGC',
        '-jar',
        jar ?? '',
        '-metadir',
        meta,
        '-noGenerateSpecTE',
        '-workers',
        'auto',
        '-config',
        config,
        'MCInbox.tla',
      ],
      { cwd: here, encoding: 'utf8', maxBuffer: 1 << 28 },
    );
    return `${run.stdout}\n${run.stderr}`;
  } finally {
    rmSync(meta, { recursive: true, force: true });
  }
}

/** What a configuration must end with: no error, or the one it names. */
function expectation(config: string) {
  const text = readFileSync(join(here, config), 'utf8');
  if (/^ {2}Bugs = \{\}$/m.test(text))
    return { name: 'every property holds', pattern: /No error has been found/ };
  const invariant = /^INVARIANTS (\w+)$/m.exec(text)?.[1];
  if (invariant)
    return {
      name: `${invariant} is violated`,
      pattern: new RegExp(`Invariant ${invariant} is violated`),
    };
  const property = /^PROPERTIES (\w+)$/m.exec(text)?.[1];
  if (property)
    return {
      name: `${property} is violated`,
      pattern: new RegExp(`Temporal property ${property} was violated`),
    };
  throw new Error(`${config} names no property`);
}

const configs = readdirSync(here)
  .filter((name) => /^MCInbox(\.\w+)?\.cfg$/.test(name))
  .sort((a, b) =>
    a === 'MCInbox.cfg' ? -1 : b === 'MCInbox.cfg' ? 1 : a.localeCompare(b),
  );
let failed = false;
for (const config of configs) {
  const expected = expectation(config);
  const output = check(config);
  const states = /(\d[\d,]*) distinct states found/.exec(output)?.[1] ?? '?';
  const ok = expected.pattern.test(output);
  console.info(
    `${ok ? 'PASS' : 'FAIL'} ${config}: ${expected.name} (${states} states)`,
  );
  if (!ok) {
    failed = true;
    console.error(output.slice(-4000));
  }
}
process.exitCode = failed ? 1 : 0;
