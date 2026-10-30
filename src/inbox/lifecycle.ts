import { statSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { WorkerConfig } from './config.js';

const DatabaseIdentity = z.strictObject({
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
export function databaseIdentity(path: string) {
  const canonical = realpathSync(path);
  const stat = statSync(canonical, { bigint: true });
  if (!stat.isFile()) throw new Error('File database required');
  return {
    database: canonical,
    identity: DatabaseIdentity.parse({
      device: String(stat.dev),
      inode: String(stat.ino),
    }),
  };
}
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
