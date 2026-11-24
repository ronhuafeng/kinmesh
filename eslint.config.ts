import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
export default defineConfig(
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  { files: ['web/**/*.{ts,tsx}'], ...reactHooks.configs.flat.recommended },
  {
    // The workspace's colours and shapes come from the design tokens
    // (tokens/, through the stylesheet), never from code.
    files: ['web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message: 'A colour is a design token: use its custom property.',
        },
        {
          selector:
            ':matches(Literal[value=/\\b(?:rgba?|hsla?|light-dark)\\(/], TemplateElement[value.raw=/\\b(?:rgba?|hsla?|light-dark)\\(/])',
          message: 'A colour is a design token: use its custom property.',
        },
        {
          selector: "JSXAttribute[name.name='style']",
          message:
            'Style belongs in the stylesheet; set a measured value with a custom property.',
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'drizzle/**',
      '.store/**',
      'dist/**',
      'web-dist/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
);
