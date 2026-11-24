import { readFileSync } from 'node:fs';
import tokenPolicy from './scripts/stylelint-token-policy.js';

/** The custom properties the tokens generate (`npm run design:build`). */
const tokens = [
  ...new Set(
    [
      ...readFileSync('web/shared/tokens.css', 'utf8').matchAll(
        /(--[a-z0-9-]+)\s*:/g,
      ),
    ].map((match) => match[1] ?? ''),
  ),
];

export default {
  plugins: [tokenPolicy],
  ignoreFiles: ['web/shared/tokens.css', 'web/shared/fonts/**'],
  rules: {
    // Colours come from the tokens: no hex, no colour functions, no names.
    'color-no-hex': true,
    'color-named': 'never',
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'light-dark'],
    // Corners are the tokens' four, a circle, or none.
    'declaration-property-value-allowed-list': {
      '/^border(-[a-z]+)*-radius$/': [
        '/^var\\(--radius(-[a-z]+)?\\)$/',
        '0',
        '50%',
        'inherit',
        '/^calc\\(var\\(--size\\) \\* [0-9.]+\\)$/',
      ],
    },
    'kinmesh/token-policy': {
      tokens,
      theme: ['--pressed', '--hairline-width'],
      runtime: [
        '--thumb-x',
        '--thumb-w',
        '--search-top',
        '--search-left',
        '--search-bottom',
      ],
    },
  },
};
