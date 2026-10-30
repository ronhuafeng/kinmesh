import { z } from 'zod';
import { Endpoint } from '../adapters/t3/oauth.js';
const Environment = z.object({
  KINMESH_DATABASE: z.string().min(1).default('.store/kinmesh.sqlite'),
  KINMESH_SETUP_TOKEN: z.string().regex(/^[a-f0-9]{64}$/),
  KINMESH_SESSION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  KINMESH_ORIGIN: z.url().default('http://127.0.0.1:3000'),
  KINMESH_T3_ENDPOINT: Endpoint.optional(),
  KINMESH_T3_AUTH_FILE: z.string().trim().min(1).optional(),
  KINMESH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});
export function loadConfig(env: NodeJS.ProcessEnv) {
  const value = Environment.parse(env);
  if (
    (value.KINMESH_T3_ENDPOINT === undefined) !==
    (value.KINMESH_T3_AUTH_FILE === undefined)
  )
    throw new Error(
      'Native T3 endpoint and credential file must be configured together.',
    );
  const origin = new URL(value.KINMESH_ORIGIN);
  if (
    origin.origin !== value.KINMESH_ORIGIN ||
    (!['https:'].includes(origin.protocol) &&
      origin.origin !== `http://127.0.0.1:${String(value.KINMESH_PORT)}`)
  ) {
    throw new Error('Use an HTTPS origin, or the exact local loopback origin.');
  }
  return {
    nativeT3:
      value.KINMESH_T3_ENDPOINT && value.KINMESH_T3_AUTH_FILE
        ? {
            endpoint: value.KINMESH_T3_ENDPOINT,
            authFile: value.KINMESH_T3_AUTH_FILE,
          }
        : undefined,
    database: value.KINMESH_DATABASE,
    setupToken: value.KINMESH_SETUP_TOKEN,
    sessionKey: Buffer.from(value.KINMESH_SESSION_KEY, 'hex'),
    origin: origin.origin,
    secureCookie: origin.protocol === 'https:',
    port: value.KINMESH_PORT,
  };
}
export type Config = ReturnType<typeof loadConfig>;
