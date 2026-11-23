import { runTeamMcp } from './process.js';

process.umask(0o077);
await runTeamMcp();
