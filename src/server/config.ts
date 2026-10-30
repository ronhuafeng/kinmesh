import { z } from 'zod';
const Environment = z.object({
  KINMESH_DATABASE: z.string().min(1).default('.store/kinmesh.sqlite'),
  KINMESH_SETUP_TOKEN: z.string().regex(/^[a-f0-9]{64}$/),
  KINMESH_SESSION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  KINMESH_ORIGIN: z.url().default('http://127.0.0.1:3000'),
  KINMESH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export function loadConfig(env: NodeJS.ProcessEnv) {
  const value = Environment.parse(env);
  const origin = new URL(value.KINMESH_ORIGIN);
  if (
    origin.origin !== value.KINMESH_ORIGIN ||
    (!['https:'].includes(origin.protocol) &&
      origin.origin !== `http://127.0.0.1:${String(value.KINMESH_PORT)}`)
  ) {
    throw new Error('Use an HTTPS origin, or the exact local loopback origin.');
  }
  return {
    database: value.KINMESH_DATABASE,
    setupToken: value.KINMESH_SETUP_TOKEN,
    sessionKey: Buffer.from(value.KINMESH_SESSION_KEY, 'hex'),
    origin: origin.origin,
    secureCookie: origin.protocol === 'https:',
    port: value.KINMESH_PORT,
  };
}
export type Config = ReturnType<typeof loadConfig>;
