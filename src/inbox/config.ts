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
export const SpaceProvisioner = z.strictObject({
  endpoint: z.url({ protocol: /^https?$/ }).max(4096),
  tokenFile: z.string().min(1).max(4096),
});
export type SpaceProvisioner = z.infer<typeof SpaceProvisioner>;
/** An agent the operator's configuration file binds; the operator asserts Team MCP. */
export const Binding = z.strictObject({
  agentId: AgentId,
  tokenFile: z.string().min(1).max(4096),
  t3Endpoint: Endpoint,
  t3AuthFile: z.string().min(1).max(4096),
  /**
   * Another credential for the same T3, used when T3 no longer honours
   * `t3AuthFile`'s or this one lets runs go further (`chooseCredential`).
   */
  t3FallbackAuthFile: z.string().min(1).max(4096).optional(),
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
  /**
   * The provisioner that makes a channel's folder in the space a T3 project,
   * and the file holding its token. Null: conversations are scratch threads.
   */
  space: SpaceProvisioner.nullable().default(null),
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
