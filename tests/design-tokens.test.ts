import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import stylelint from 'stylelint';
import { z } from 'zod';
import {
  DESIGN_MD,
  INDEX_HTML,
  MANIFEST,
  projectDesignTokens,
  projectHostColors,
} from '../scripts/design-tokens.js';
import config from '../stylelint.config.js';

// `npm run design:check` (CI) proves the committed projections are fresh;
// these prove a token reaches both of them, and that a stylesheet can't go
// around the tokens.

await test('a token changed in tokens/ reaches the stylesheet and DESIGN.md, light and dark', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kinmesh-tokens-'));
  try {
    cpSync('tokens', directory, { recursive: true });
    const edit = (
      file: string,
      group: string,
      name: string,
      value: unknown,
    ) => {
      const path = join(directory, file);
      const tokens = z
        .object({ $schema: z.string() })
        .catchall(z.record(z.string(), z.unknown()))
        .parse(JSON.parse(readFileSync(path, 'utf8')));
      const tokenGroup = tokens[group];
      assert.ok(tokenGroup);
      tokenGroup[name] = value;
      writeFileSync(path, JSON.stringify(tokens));
    };
    edit('light.tokens.json', 'color', 'primary', {
      $type: 'color',
      $value: {
        colorSpace: 'srgb',
        components: [0, 0.5, 1],
        hex: '#0080ff',
      },
    });
    edit('dark.tokens.json', 'color', 'primary', {
      $type: 'color',
      $value: {
        colorSpace: 'srgb',
        components: [1, 0.5, 0],
        hex: '#ff8000',
      },
    });
    edit('shared.tokens.json', 'rounded', 'md', {
      $type: 'dimension',
      $value: { value: 3, unit: 'px' },
    });
    const projected = await projectDesignTokens(
      readFileSync(DESIGN_MD, 'utf8'),
      pathToFileURL(join(directory, 'kinmesh.resolver.json')),
    );
    const [light, dark] = projected.css.split(":root[data-theme='dark']");
    assert.match(light ?? '', /--primary: #0080ff;/);
    assert.match(light ?? '', /--radius: 3px;/);
    assert.match(dark ?? '', /--primary: #ff8000;/);
    assert.match(dark ?? '', /prefers-color-scheme: dark/);
    assert.doesNotMatch(dark ?? '', /--radius:/);
    assert.match(projected.designMd, /^ {2}primary: '#0080ff'$/m);
    assert.match(projected.designMd, /^ {2}dark-primary: '#ff8000'$/m);
    assert.match(projected.designMd, /^ {2}md: 3px$/m);
    // The body is the document's own, untouched.
    const body = (source: string) => source.slice(source.indexOf('\n# '));
    assert.equal(
      body(projected.designMd),
      body(readFileSync(DESIGN_MD, 'utf8')),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test('a stylesheet uses the tokens: no raw colour, corner or shadow, no unknown property', async () => {
  const lint = async (code: string) =>
    (await stylelint.lint({ code, config })).results[0]?.warnings.map(
      (warning) => warning.text,
    ) ?? [];
  assert.deepEqual(
    await lint(
      '.a { color: var(--ink); border-radius: var(--radius); box-shadow: var(--elev-1); --tone: var(--ok); background: color-mix(in srgb, var(--tone) 12%, var(--paper)); }\n',
    ),
    [],
  );
  const refused = (
    await lint(
      '.a { color: #fff; background: rgb(0 0 0 / 0.1); border-radius: 10px; --glow: 0 0 4px red; outline-color: var(--nowhere); }\n:root { --primary: blue; }\n',
    )
  ).join('\n');
  for (const reason of [
    /hex color "#fff"/,
    /function "rgb"/,
    /"10px" for property "border-radius"/,
    /--glow hides a raw colour/,
    /--nowhere is neither a token/,
    /--primary is a generated token/,
  ])
    assert.match(refused, reason);
});

await test('the page and the installed app take their theme colours from the tokens', () => {
  const host = projectHostColors(
    readFileSync(INDEX_HTML, 'utf8'),
    readFileSync(MANIFEST, 'utf8'),
    { paper: '#010203', darkPaper: '#040506', primary: '#070809' },
  );
  assert.match(
    host.html,
    /content="#010203"\s+media="\(prefers-color-scheme: light\)"/,
  );
  assert.match(
    host.html,
    /content="#040506"\s+media="\(prefers-color-scheme: dark\)"/,
  );
  assert.match(host.manifest, /"background_color": "#010203"/);
  assert.match(host.manifest, /"theme_color": "#070809"/);
});

await test('a disable comment does not turn the token policy off', async () => {
  const [result] = (
    await stylelint.lint({
      code: '/* stylelint-disable */\n.a { color: #fff; }\n',
      config,
    })
  ).results;
  assert.ok(
    result?.warnings.some((warning) => warning.text.includes('hex color')),
  );
});
