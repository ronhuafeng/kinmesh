import { z } from 'zod';
const Environment = z.object({
  KINMESH_DATABASE: z.string().min(1).default('.store/kinmesh.sqlite'),
  KINMESH_SESSION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  KINMESH_ORIGIN: z.url().default('http://127.0.0.1:3000'),
  KINMESH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Requests per minute per client: a guard against floods, at human pace. */
  KINMESH_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(60),
  /** The Feishu app people sign in through. */
  FEISHU_APP_ID: z.string().trim().min(1),
  FEISHU_APP_SECRET: z.string().trim().min(1),
  /** Only a verified mailbox in this domain may sign in. */
  KINMESH_EMAIL_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
    ),
  /** A stand-in for Feishu's hosts, for tests only. */
  KINMESH_FEISHU_URL: z.url().optional(),
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
    sessionKey: Buffer.from(value.KINMESH_SESSION_KEY, 'hex'),
    origin: origin.origin,
    secureCookie: origin.protocol === 'https:',
    port: value.KINMESH_PORT,
    rateLimit: value.KINMESH_RATE_LIMIT,
    feishu: {
      appId: value.FEISHU_APP_ID,
      appSecret: value.FEISHU_APP_SECRET,
      emailDomain: value.KINMESH_EMAIL_DOMAIN,
      /** Feishu's own hosts unless a test stands in for them. */
      standIn: value.KINMESH_FEISHU_URL
        ? new URL(value.KINMESH_FEISHU_URL).origin
        : null,
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
