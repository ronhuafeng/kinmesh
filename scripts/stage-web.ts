import { cpSync } from 'node:fs';
cpSync('web-dist', 'dist/web-dist', { recursive: true });
