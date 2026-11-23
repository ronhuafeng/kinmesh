import { runHub } from './hub-process.js';

process.umask(0o077);
await runHub();
