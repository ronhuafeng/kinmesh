import { z } from 'zod';
import { WorkerConfig } from './config.js';

/**
 * Which database a process uses: its name and the object ID PostgreSQL gave
 * it, which a dropped and recreated database does not keep.
 */
export const DatabaseIdentity = z.strictObject({
  database: z.string().min(1),
  oid: z.string().regex(/^\d+$/),
});
export type DatabaseIdentity = z.infer<typeof DatabaseIdentity>;
export const sameDatabase = (a: DatabaseIdentity, b: DatabaseIdentity) =>
  a.database === b.database && a.oid === b.oid;
export const Initialize = z.strictObject({
  type: z.literal('inbox.initialize'),
  config: WorkerConfig,
  identity: DatabaseIdentity,
});
export const Run = z.strictObject({ type: z.literal('inbox.run') });
export type WorkerCommand = z.infer<typeof Initialize> | z.infer<typeof Run>;
export const WorkerEvent = z.strictObject({
  type: z.enum(['inbox.prepared', 'inbox.running']),
  identity: DatabaseIdentity,
});
export type WorkerEvent = z.infer<typeof WorkerEvent>;

// A supervisor's IPC disconnect must also bound orphan cleanup after parent SIGKILL.
export const WORKER_SHUTDOWN_MS = 10_000;
