import { isIP } from 'node:net';
import { z } from 'zod';

/** An address or a CIDR range, as a proxy may be named. */
const ProxyAddress = z
  .string()
  .trim()
  .refine((value) => {
    const [address = '', prefix, extra] = value.split('/');
    const family = isIP(address);
    if (family === 0 || extra !== undefined) return false;
    if (prefix === undefined) return true;
    const bits = Number(prefix);
    return (
      /^\d+$/.test(prefix) && bits >= 0 && bits <= (family === 4 ? 32 : 128)
    );
  });
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
  /** Lets a scraper elsewhere read /metrics; this machine needs none. */
  KINMESH_METRICS_TOKEN: z.string().min(32).optional(),
  /** A stand-in for Feishu's hosts, for tests only. */
  KINMESH_FEISHU_URL: z.url().optional(),
  /**
   * The reverse proxies whose forwarding header names the client: addresses
   * or CIDR ranges, comma-separated. Unset, no forwarding header is trusted.
   */
  KINMESH_TRUSTED_PROXIES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(ProxyAddress)),
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
  // The hub listens on loopback, so an HTTPS origin means a proxy in front;
  // without trusting it, everyone would share one client's limits.
  if (
    origin.protocol === 'https:' &&
    value.KINMESH_TRUSTED_PROXIES.length === 0
  )
    throw new Error('An HTTPS origin needs KINMESH_TRUSTED_PROXIES.');
  return {
    database: value.KINMESH_DATABASE,
    sessionKey: Buffer.from(value.KINMESH_SESSION_KEY, 'hex'),
    origin: origin.origin,
    secureCookie: origin.protocol === 'https:',
    port: value.KINMESH_PORT,
    rateLimit: value.KINMESH_RATE_LIMIT,
    trustedProxies: value.KINMESH_TRUSTED_PROXIES,
    metricsToken: value.KINMESH_METRICS_TOKEN ?? null,
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
