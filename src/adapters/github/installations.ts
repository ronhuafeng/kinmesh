import { createSign } from 'node:crypto';
import { z } from 'zod';
import { Repository } from '../../domain/pull-requests.js';

/** Why GitHub gave no answer Kinmesh can use. */
export class GitHubRefused extends Error {
  override readonly name = 'GitHubRefused';
  constructor(readonly status: number) {
    super(`GitHub answered ${String(status)}`);
  }
}
const headers = (authorization: string | null) => ({
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'kinmesh',
  ...(authorization ? { authorization } : {}),
});
/** One request to GitHub's REST API, its JSON parsed by `schema`. */
async function call<T>(
  api: string,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: 'GET' | 'POST'; authorization?: string | null } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, api), {
      method: init.method ?? 'GET',
      headers: headers(init.authorization ?? null),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubRefused(0);
  }
  if (!response.ok) throw new GitHubRefused(response.status);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new GitHubRefused(response.status);
  return parsed.data;
}

/** What GitHub hands over once a person creates the app from its manifest. */
export const CreatedApp = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
  pem: z.string().startsWith('-----BEGIN'),
});
export type CreatedApp = z.infer<typeof CreatedApp>;
/** The code GitHub sends back after a person creates the app, exchanged once. */
export const convertManifest = (api: string, code: string) =>
  call(
    api,
    `/app-manifests/${encodeURIComponent(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,100}$/)
        .parse(code),
    )}/conversions`,
    CreatedApp,
    { method: 'POST' },
  );

/** The app's own short credential (a JWT, ten minutes at most). */
export function appJwt(appId: number, pem: string, now = Date.now()) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const seconds = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    // A minute early, for a clock that runs ahead of GitHub's.
    iat: seconds - 60,
    exp: seconds + 9 * 60,
    iss: String(appId),
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(pem);
  return `${unsigned}.${signature.toString('base64url')}`;
}

/** Where the app is installed: whose account, and where its settings are. */
export const Installation = z.object({
  id: z.number().int().positive(),
  app_id: z.number().int().positive(),
  account: z.object({ login: z.string().min(1).max(100) }),
  repository_selection: z.enum(['all', 'selected']),
  html_url: z.url(),
});
export const installation = (
  api: string,
  app: { appId: number; pem: string },
  id: number,
) =>
  call(api, `/app/installations/${String(id)}`, Installation, {
    authorization: `Bearer ${appJwt(app.appId, app.pem)}`,
  });

/** An installation's own short credential, for what it was given. */
export const InstallationToken = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime(),
});
export const installationToken = (
  api: string,
  app: { appId: number; pem: string },
  id: number,
) =>
  call(
    api,
    `/app/installations/${String(id)}/access_tokens`,
    InstallationToken,
    {
      method: 'POST',
      authorization: `Bearer ${appJwt(app.appId, app.pem)}`,
    },
  );

/** The repositories an installation reaches, by name (the first hundred). */
export async function installationRepositories(api: string, token: string) {
  const page = await call(
    api,
    '/installation/repositories?per_page=100',
    z.object({
      total_count: z.number().int().nonnegative(),
      repositories: z.array(z.object({ full_name: Repository })),
    }),
    { authorization: `Bearer ${token}` },
  );
  return {
    names: page.repositories.map((r) => r.full_name),
    more: page.total_count > page.repositories.length,
  };
}
