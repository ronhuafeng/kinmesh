import { readFileSync, writeFileSync } from 'node:fs';
import { lint } from '@google/design.md/linter';
import {
  build,
  defineConfig,
  parse,
  type TokenNormalized,
  type TokenNormalizedSet,
} from '@terrazzo/parser';
import css from '@terrazzo/plugin-css';
import { format, resolveConfig } from 'prettier';

/**
 * The design tokens in `tokens/` are the one authority for Kinmesh's reusable
 * visual decisions. This projects them, unchanged, into the stylesheet's
 * custom properties (`web/shared/tokens.css`), the token frontmatter of
 * `docs/design/DESIGN.md`, and the theme colours of the page and the web app
 * manifest. `npm run design:build` writes both;
 * `npm run design:check` fails when either is stale.
 */

const RESOLVER = new URL('../tokens/kinmesh.resolver.json', import.meta.url);
const ROOT = new URL('../', import.meta.url);
export const TOKENS_CSS = 'web/shared/tokens.css';
export const DESIGN_MD = 'docs/design/DESIGN.md';

/** Names the stylesheet already speaks; anything else is its path, dashed. */
const NAMES: Record<string, string> = {
  'font.sans': 'font',
  'font.mono': 'mono',
  'font.code': 'mono-block',
  'rounded.md': 'radius',
  'rounded.full': 'radius-pill',
  'size.reading': 'reading',
  'size.conversation': 'conversation',
  'duration.base': 'dur',
  'duration.fast': 'dur-fast',
  'duration.press': 'dur-press',
  'easing.out': 'ease-out',
  'easing.spring': 'spring',
  'control.touch': 'target-touch',
  'control.row': 'target-row',
  'control.header': 'target-header',
};

function variableName(token: TokenNormalized): string {
  const named = NAMES[token.id];
  if (named) return named;
  const [group, ...rest] = token.id.split('.');
  const name = rest.join('-');
  if (group === 'color') return name;
  if (group === 'rounded') return `radius-${name}`;
  if (group === 'elevation') return `elev-${name}`;
  return `${group ?? ''}-${name}`;
}

const DARK = [
  ":root[data-theme='dark']",
  "@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light'])",
];

const config = defineConfig(
  {
    plugins: [
      css({
        filename: 'tokens.css',
        legacyHex: true,
        exclude: ['typography.*'],
        variableName: (token) => `--${variableName(token)}`,
        // System font keywords (BlinkMacSystemFont) only work unquoted.
        transform: (token) =>
          token.$type === 'fontFamily' ? family(token.$value) : undefined,
        permutations: [
          {
            input: { theme: 'light' },
            prepare: (contents) => `:root {\n${contents}\n}\n`,
          },
          {
            input: { theme: 'dark' },
            include: ['color.*', 'elevation.*'],
            prepare: (contents) =>
              `${DARK[0] ?? ''} {\n${contents}\n}\n${DARK[1] ?? ''} {\n${contents}\n  }\n}\n`,
          },
        ],
      }),
    ],
  },
  { cwd: ROOT },
);

function token(tokens: TokenNormalizedSet, id: string): TokenNormalized {
  const found = tokens[id];
  if (!found) throw new Error(`Missing resolved token ${id}.`);
  return found;
}

function hex(tokens: TokenNormalizedSet, id: string): string {
  const found = token(tokens, id);
  if (found.$type !== 'color' || !found.$value.hex)
    throw new Error(`${id} is not an sRGB colour.`);
  const alpha = found.$value.alpha;
  if (alpha === 1) return found.$value.hex;
  return (
    found.$value.hex +
    Math.round(alpha * 255)
      .toString(16)
      .padStart(2, '0')
  );
}

function dimension(tokens: TokenNormalizedSet, id: string): string {
  const found = token(tokens, id);
  if (found.$type !== 'dimension') throw new Error(`${id} is not a dimension.`);
  return `${String(found.$value.value)}${found.$value.unit}`;
}

function ids(tokens: TokenNormalizedSet, group: string): string[] {
  return Object.keys(tokens).filter((id) => id.startsWith(`${group}.`));
}

const GENERIC = new Set([
  '-apple-system',
  'BlinkMacSystemFont',
  'system-ui',
  'sans-serif',
  'monospace',
  'ui-monospace',
]);
function family(families: string | readonly string[]): string {
  return (typeof families === 'string' ? [families] : families)
    .map((name) =>
      GENERIC.has(name) || /^[A-Za-z-]+$/.test(name) ? name : `"${name}"`,
    )
    .join(', ');
}

function typography(tokens: TokenNormalizedSet, id: string): string {
  const found = token(tokens, id);
  if (found.$type !== 'typography') throw new Error(`${id} is not typography.`);
  const value = found.$value;
  const size = value.fontSize;
  const spacing = value.letterSpacing;
  if (
    typeof value.fontWeight !== 'number' ||
    typeof value.lineHeight !== 'number'
  )
    throw new Error(`${id} needs a size, weight and line height.`);
  const lines = [
    `    fontFamily: '${family(value.fontFamily)}'`,
    `    fontSize: ${String(size.value)}${size.unit}`,
    `    fontWeight: ${String(value.fontWeight)}`,
    `    lineHeight: ${String(value.lineHeight)}`,
  ];
  if (spacing.value !== 0)
    lines.push(`    letterSpacing: ${String(spacing.value)}${spacing.unit}`);
  return lines.join('\n');
}

/** The components an agent most often draws, in the tokens' own terms. */
const COMPONENTS = `components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "{spacing.target-header}"
  button-secondary:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "{spacing.target-header}"
  field:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "{spacing.3}"
  list:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.lg}"
  popover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  composer:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  segmented:
    backgroundColor: "{colors.fill}"
    rounded: "{rounded.lg}"
  segmented-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  sidebar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
  sidebar-row:
    typography: "{typography.ui}"
    rounded: "{rounded.md}"
    height: "{spacing.target-row}"
  inline-code:
    backgroundColor: "{colors.sunken}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
  decision:
    backgroundColor: "{colors.decision-soft}"
    textColor: "{colors.decision-text}"
  badge:
    backgroundColor: "{colors.badge}"
    textColor: "{colors.on-badge}"
    rounded: "{rounded.full}"
  avatar:
    rounded: "{rounded.full}"
`;

function frontmatter(
  light: TokenNormalizedSet,
  dark: TokenNormalizedSet,
): string {
  const colors = ids(light, 'color').map((id) => id.slice('color.'.length));
  return [
    '---',
    'version: alpha',
    'name: Kinmesh',
    'description: A calm precision workroom for people and AI agents; solid paper on a grey canvas, crisp hairlines, tight corners and one deep green.',
    'colors:',
    ...colors.map((name) => `  ${name}: "${hex(light, `color.${name}`)}"`),
    ...colors.map((name) => `  dark-${name}: "${hex(dark, `color.${name}`)}"`),
    'typography:',
    ...ids(light, 'typography').flatMap((id) => [
      `  ${id.slice('typography.'.length)}:`,
      typography(light, id),
    ]),
    'rounded:',
    ...ids(light, 'rounded').map(
      (id) => `  ${id.slice('rounded.'.length)}: ${dimension(light, id)}`,
    ),
    'spacing:',
    ...ids(light, 'space').map(
      (id) => `  "${id.slice('space.'.length)}": ${dimension(light, id)}`,
    ),
    ...ids(light, 'control').map(
      (id) =>
        `  target-${id.slice('control.'.length)}: ${dimension(light, id)}`,
    ),
    ...ids(light, 'size').map(
      (id) => `  ${id.slice('size.'.length)}: ${dimension(light, id)}`,
    ),
    COMPONENTS + '---',
    '',
  ].join('\n');
}

function body(source: string): string {
  if (!source.startsWith('---\n')) return source;
  const close = source.indexOf('\n---\n', 4);
  if (close < 0) throw new Error(`${DESIGN_MD}: its frontmatter never closes.`);
  return source.slice(close + '\n---\n'.length);
}

/** Where the browser and the installed app take their colours before the
 * stylesheet loads: the page's theme colour and the web app manifest. */
export const INDEX_HTML = 'web/index.html';
export const MANIFEST = 'web/public/manifest.webmanifest';

export interface Projection {
  readonly css: string;
  readonly designMd: string;
  readonly theme: {
    readonly paper: string;
    readonly darkPaper: string;
    readonly primary: string;
  };
}

function replaceOnce(source: string, pattern: RegExp, value: string): string {
  if (!pattern.test(source))
    throw new Error(`Nothing matches ${String(pattern)} to project into.`);
  return source.replace(pattern, (_match, head: string) => `${head}${value}`);
}

/** The page's theme colours and the manifest's, from the same tokens. */
export function projectHostColors(
  html: string,
  manifest: string,
  theme: Projection['theme'],
): { readonly html: string; readonly manifest: string } {
  return {
    html: replaceOnce(
      replaceOnce(
        html,
        /(name="theme-color"\s+content=")#[0-9a-f]+(?="\s+media="\(prefers-color-scheme: light\)")/,
        theme.paper,
      ),
      /(name="theme-color"\s+content=")#[0-9a-f]+(?="\s+media="\(prefers-color-scheme: dark\)")/,
      theme.darkPaper,
    ),
    manifest: replaceOnce(
      replaceOnce(
        manifest,
        /("background_color": ")#[0-9a-f]+(?=")/,
        theme.paper,
      ),
      /("theme_color": ")#[0-9a-f]+(?=")/,
      theme.primary,
    ),
  };
}

export async function projectDesignTokens(
  designMd: string,
  resolver: URL = RESOLVER,
): Promise<Projection> {
  const parsed = await parse(
    [{ filename: resolver, src: readFileSync(resolver, 'utf8') }],
    {
      config,
    },
  );
  const light = parsed.resolver.apply({ theme: 'light' });
  const dark = parsed.resolver.apply({ theme: 'dark' });
  const built = await build(light, {
    resolver: parsed.resolver,
    sources: parsed.sources,
    config,
  });
  const file = built.outputFiles.find((entry) =>
    entry.filename.endsWith('tokens.css'),
  );
  if (!file) throw new Error('Terrazzo did not generate tokens.css.');
  // In the repository's own format, so formatting never makes it stale.
  const projected = await format(
    `${frontmatter(light, dark)}${body(designMd)}`,
    {
      ...(await resolveConfig(DESIGN_MD)),
      filepath: DESIGN_MD,
    },
  );
  const report = lint(projected);
  const errors = report.findings.filter(
    (finding) => finding.severity === 'error',
  );
  if (errors.length > 0)
    throw new Error(
      `${DESIGN_MD} does not lint:\n${errors.map((finding) => finding.message).join('\n')}`,
    );
  return {
    css: String(file.contents).replace(/^--/gm, '  --'),
    designMd: projected,
    theme: {
      paper: hex(light, 'color.paper'),
      darkPaper: hex(dark, 'color.paper'),
      primary: hex(light, 'color.primary'),
    },
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const projection = await projectDesignTokens(readFileSync(DESIGN_MD, 'utf8'));
  const host = projectHostColors(
    readFileSync(INDEX_HTML, 'utf8'),
    readFileSync(MANIFEST, 'utf8'),
    projection.theme,
  );
  const stale: string[] = [];
  for (const [path, contents] of [
    [TOKENS_CSS, projection.css],
    [DESIGN_MD, projection.designMd],
    [INDEX_HTML, host.html],
    [MANIFEST, host.manifest],
  ] as const) {
    if (readFileSync(path, 'utf8') === contents) continue;
    if (check) stale.push(path);
    else writeFileSync(path, contents);
  }
  if (stale.length > 0) {
    console.error(
      `${stale.join(', ')}: out of date with tokens/. Run npm run design:build.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) await main();
