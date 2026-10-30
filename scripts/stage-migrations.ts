import { cpSync, mkdirSync } from 'node:fs';
// tsc emits runtime JS only into ignored dist; stage the generated migration assets it needs.
mkdirSync('dist/drizzle', { recursive: true });
cpSync('drizzle', 'dist/drizzle', { recursive: true });
