import { isIP } from 'node:net';
import { z } from 'zod';
import { storeConfig } from '../persistence/attachment-store.js';
import { DatabaseUrl } from '../persistence/database.js';
import { Endpoint } from '../adapters/t3/oauth.js';

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
  /** The team's PostgreSQL. */
  KINMESH_DATABASE_URL: DatabaseUrl,
  /** Private files the hub keeps for its worker (tokens, T3 credential). */
  KINMESH_STATE: z.string().min(1).default('.store'),
  KINMESH_SESSION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  KINMESH_ORIGIN: z.url().default('http://127.0.0.1:3000'),
  KINMESH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * The address the hub listens on: loopback, unless a container publishes
   * its port (to the host's loopback, behind the proxy).
   */
  KINMESH_HOST: z
    .string()
    .trim()
    .refine((value) => isIP(value) !== 0)
    .default('127.0.0.1'),
  /**
   * Requests per minute for each signed-in session, and for each address
   * among everyone else: a guard against floods, at human pace.
   */
  KINMESH_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(300),
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
  /**
   * A T3 the deployment connects: its MCP URL, and the file holding the
   * session it issued for the hub (`t3 auth session issue --json`). Both or
   * neither; with them agents run without anyone signing in, and a person's
   * broader sign-in to the same T3 is used while it lasts.
   */
  KINMESH_T3_ENDPOINT: Endpoint.optional(),
  /**
   * Where Team MCP is served (the same setting Team MCP reads), so the
   * workspace can say where an agent's token goes.
   */
  KINMESH_TEAM_MCP_ORIGIN: z.url().optional(),
  KINMESH_T3_CREDENTIAL_FILE: z.string().min(1).optional(),
  /**
   * The provisioner beside T3 that makes a channel's folder in the space a
   * T3 project, and the file holding its token. Both or neither; without
   * them agents' conversations are scratch threads.
   */
  KINMESH_SPACE_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  KINMESH_SPACE_TOKEN_FILE: z.string().min(1).optional(),
  /**
   * A file holding a read-only GitHub token, for pull requests in private
   * repositories linked to tasks. Unset, Kinmesh reads public ones only.
   */
  KINMESH_GITHUB_TOKEN_FILE: z.string().min(1).optional(),
  /** A stand-in for GitHub's API, for tests only. */
  KINMESH_GITHUB_API: z.url().optional(),
  /** The most the team's files may hold together, in bytes; 10 GiB. */
  KINMESH_ATTACHMENTS_ROOM: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 ** 3),
  /** Lets a scraper elsewhere read /metrics; this machine needs none. */
  KINMESH_METRICS_TOKEN: z.string().min(32).optional(),
  /**
   * The commit the hub was built from, which the image sets; empty or unset
   * when built elsewhere.
   */
  KINMESH_VERSION: z
    .string()
    .regex(/^(?:[0-9a-f]{40})?$/)
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
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
  if (
    (value.KINMESH_T3_ENDPOINT === undefined) !==
    (value.KINMESH_T3_CREDENTIAL_FILE === undefined)
  )
    throw new Error(
      'Set KINMESH_T3_ENDPOINT and KINMESH_T3_CREDENTIAL_FILE together.',
    );
  if (
    (value.KINMESH_SPACE_ENDPOINT === undefined) !==
    (value.KINMESH_SPACE_TOKEN_FILE === undefined)
  )
    throw new Error(
      'Set KINMESH_SPACE_ENDPOINT and KINMESH_SPACE_TOKEN_FILE together.',
    );
  return {
    database: value.KINMESH_DATABASE_URL,
    state: value.KINMESH_STATE,
    files: storeConfig(env),
    attachmentsRoom: value.KINMESH_ATTACHMENTS_ROOM,
    sessionKey: Buffer.from(value.KINMESH_SESSION_KEY, 'hex'),
    origin: origin.origin,
    secureCookie: origin.protocol === 'https:',
    port: value.KINMESH_PORT,
    host: value.KINMESH_HOST,
    rateLimit: value.KINMESH_RATE_LIMIT,
    trustedProxies: value.KINMESH_TRUSTED_PROXIES,
    metricsToken: value.KINMESH_METRICS_TOKEN ?? null,
    /** The commit the hub was built from, if known. */
    version: value.KINMESH_VERSION ?? null,
    /**
     * Team MCP's endpoint: its configured origin; on a hub on loopback, the
     * local default; else none, and the workspace offers no Team MCP token.
     */
    teamMcpUrl: value.KINMESH_TEAM_MCP_ORIGIN
      ? new URL('/mcp', value.KINMESH_TEAM_MCP_ORIGIN).href
      : origin.protocol === 'https:'
        ? null
        : 'http://127.0.0.1:3001/mcp',
    /** The T3 the deployment connects, if it does. */
    t3:
      value.KINMESH_T3_ENDPOINT && value.KINMESH_T3_CREDENTIAL_FILE
        ? {
            endpoint: value.KINMESH_T3_ENDPOINT,
            credentialFile: value.KINMESH_T3_CREDENTIAL_FILE,
          }
        : null,
    /** Where channels' T3 projects are made, if the deployment has a space. */
    space:
      value.KINMESH_SPACE_ENDPOINT && value.KINMESH_SPACE_TOKEN_FILE
        ? {
            endpoint: value.KINMESH_SPACE_ENDPOINT,
            tokenFile: value.KINMESH_SPACE_TOKEN_FILE,
          }
        : null,
    /** Where pull requests linked to tasks are read. */
    github: {
      api: value.KINMESH_GITHUB_API
        ? new URL(value.KINMESH_GITHUB_API).origin
        : 'https://api.github.com',
      tokenFile: value.KINMESH_GITHUB_TOKEN_FILE ?? null,
    },
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
