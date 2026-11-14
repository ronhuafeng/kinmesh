import {
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  constants,
} from 'node:fs';
import { z } from 'zod';
import { DatabaseUrl } from '../persistence/database.js';
import { AgentId } from '../domain/contracts.js';
import { Endpoint } from '../adapters/t3/oauth.js';
/** An agent the operator's configuration file binds; the operator asserts Team MCP. */
export const Binding = z.strictObject({
  agentId: AgentId,
  tokenFile: z.string().min(1).max(4096),
  t3Endpoint: Endpoint,
  t3AuthFile: z.string().min(1).max(4096),
  isolatedProviderId: z.string().min(1).max(256),
  externalTeamMcpConfigured: z.literal(true),
});
/** What the worker serves an agent with, whether operator-configured or managed. */
export const WorkerBinding = Binding.omit({ externalTeamMcpConfigured: true });
export type WorkerBinding = z.infer<typeof WorkerBinding>;
export const WorkerConfig = z.strictObject({
  /** The team's PostgreSQL, as a connection URL. */
  database: DatabaseUrl,
  /** Where the hub keeps the worker's private files. */
  state: z.string().min(1).max(4096).default('.store'),
  pollMs: z.number().int().min(100).max(30000).default(1000),
  bindings: z
    .array(Binding)
    .max(32)
    .refine((v) => new Set(v.map((b) => b.agentId)).size === v.length),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;
export function loadWorkerConfig(path: string) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (stat.mode & 0o177) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error('Private worker configuration required');
    return WorkerConfig.parse(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}
