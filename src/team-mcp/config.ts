import { z } from 'zod';
const Environment = z.object({
  KINMESH_DATABASE: z.string().min(1).default('.store/kinmesh.sqlite'),
  KINMESH_TEAM_MCP_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(3001),
  KINMESH_TEAM_MCP_ORIGIN: z.url().optional(),
  KINMESH_TEAM_MCP_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(16),
});
export function teamConfig(env: NodeJS.ProcessEnv) {
  const data = Environment.parse(env);
  const local = `http://127.0.0.1:${String(data.KINMESH_TEAM_MCP_PORT)}`;
  const origin = new URL(data.KINMESH_TEAM_MCP_ORIGIN ?? local);
  if (
    origin.origin !== origin.href.replace(/\/$/, '') ||
    (origin.protocol !== 'https:' && origin.origin !== local)
  )
    throw new Error('Invalid Team MCP origin');
  return {
    database: data.KINMESH_DATABASE,
    port: data.KINMESH_TEAM_MCP_PORT,
    origin: origin.origin,
    hosts: [new URL(local).host, origin.host],
    concurrency: data.KINMESH_TEAM_MCP_CONCURRENCY,
  };
}
export type TeamConfig = ReturnType<typeof teamConfig>;
