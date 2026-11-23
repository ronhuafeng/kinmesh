import { runInbox } from './process.js';

process.umask(0o077);
await runInbox();
