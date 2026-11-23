import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
export default defineConfig(
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  { files: ['web/**/*.{ts,tsx}'], ...reactHooks.configs.flat.recommended },
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
