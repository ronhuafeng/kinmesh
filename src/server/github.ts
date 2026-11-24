import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { HumanId, TeamId } from '../domain/contracts.js';
import { DomainError } from '../domain/errors.js';
import type { Principal } from '../domain/agents.js';
import type { Store } from '../persistence/store.js';
import {
  convertManifest,
  installation,
  installationRepositories,
  installationToken,
} from '../adapters/github/installations.js';
import { readGitHubApp, writeGitHubApp } from '../runtime/managed.js';
import { principal } from './principals.js';
import { GitHubManifest, GitHubStatus } from '../domain/github-connection.js';

export interface GitHubPlaces {
  /** GitHub's REST API origin. */
  api: string;
  /** GitHub's own pages, where a person creates and installs the app. */
  web: string;
}
/** The person behind a principal the routes already checked is one. */
const humanOf = (p: Principal) => {
  if (p.kind !== 'human') throw new Error('A person is required');
  return p.humanId;
};
/** How long a person has to finish on GitHub what they started here. */
const STATE_MS = 30 * 60_000;
const TeamPath = z.object({ teamId: TeamId });
/** Where GitHub sends the person back to, and where they land after. */
const BACK = '/?settings=connections';

/**
 * The installation's own credential, minted from the team's app and kept
 * until a few minutes before it ends; null while no app is installed. The
 * hub's reads of pull requests and checks use it.
 */
export function githubTokens(
  store: Store,
  directory: string,
  places: GitHubPlaces,
) {
  let held: { installationId: number; token: string; until: number } | null =
    null;
  return async (): Promise<string | null> => {
    const installationId = await store.githubConnections.installation();
    const app = readGitHubApp(directory);
    if (installationId === null || app === null) return null;
    if (
      held?.installationId === installationId &&
      held.until - Date.now() > 5 * 60_000
    )
      return held.token;
    const minted = await installationToken(places.api, app, installationId);
    held = {
      installationId,
      token: minted.token,
      until: Date.parse(minted.expires_at),
    };
    return minted.token;
  };
}

/**
 * 连接 › GitHub: a person connects the team's GitHub in two steps on
 * GitHub's own pages — creating the team's app, then choosing the
 * repositories it may use — and lands back on the connections page. The
 * app's key stays in the hub's private directory.
 */
export function registerGitHub(
  app: FastifyInstance,
  store: Store,
  options: {
    directory: string;
    places: GitHubPlaces;
    origin: string;
    sessionKey: Buffer;
    token: () => Promise<string | null>;
  },
) {
  const { directory, places, origin, sessionKey } = options;
  /** A note GitHub carries back, binding the step to this person and team. */
  const sign = (body: string) =>
    createHmac('sha256', sessionKey)
      .update('github:' + body)
      .digest('base64url');
  const stateFor = (teamId: string, humanId: string) => {
    const body = [
      teamId,
      humanId,
      String(Date.now() + STATE_MS),
      randomBytes(8).toString('base64url'),
    ].join('.');
    return body + '.' + sign(body);
  };
  /**
   * Who is finishing which team's step, if the note is one this hub signed
   * and still fresh. GitHub sends the person back from its own site, which
   * the session cookie (SameSite=Strict) does not follow, so the note
   * stands for them; the repository still checks they are of the team.
   */
  const stepOf = (state: string) => {
    const parts = state.split('.');
    if (parts.length !== 5) return null;
    const body = parts.slice(0, 4).join('.');
    const expected = Buffer.from(sign(body));
    const given = Buffer.from(parts[4] ?? '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return null;
    const [teamId, humanId, until] = parts;
    const team = TeamId.safeParse(teamId);
    const human = HumanId.safeParse(humanId);
    if (!team.success || !human.success || Number(until) < Date.now())
      return null;
    return {
      teamId: team.data,
      person: { kind: 'human', humanId: human.data } satisfies Principal,
    };
  };
  const back = (reply: FastifyReply, failed: boolean) =>
    reply.redirect(failed ? BACK + '&github=failed' : BACK);

  // What the connections page shows: nothing yet, an app to install, or
  // the account and repositories agents may work in.
  app.get('/api/teams/:teamId/github', async (request) =>
    GitHubStatus.parse(await status(request)),
  );
  const status = async (request: {
    params: unknown;
    principal: Principal | null;
  }) => {
    const { teamId } = TeamPath.parse(request.params);
    if (request.principal === null) throw new DomainError('unauthenticated');
    const p = request.principal;
    const row = await store.githubConnections.connection(p, teamId);
    const key = readGitHubApp(directory);
    if (row === null || key === null) return { state: 'none' as const };
    if (row.installationId === null)
      return {
        state: 'created' as const,
        installUrl: `${places.web}/apps/${row.slug}/installations/new?state=${encodeURIComponent(stateFor(teamId, humanOf(p)))}`,
      };
    try {
      const [where, token] = await Promise.all([
        installation(places.api, key, row.installationId),
        options.token(),
      ]);
      const repositories =
        where.repository_selection === 'all' || token === null
          ? null
          : await installationRepositories(places.api, token);
      return {
        state: 'installed' as const,
        account: where.account.login,
        repositories: repositories?.names ?? null,
        more: repositories?.more ?? false,
        manageUrl: where.html_url,
      };
    } catch {
      return {
        state: 'unreachable' as const,
        account: row.account,
      };
    }
  };

  // The manifest the page posts to GitHub to create the team's app.
  app.post('/api/teams/:teamId/github/connect', async (request) => {
    const { teamId } = TeamPath.parse(request.params);
    const p = principal(request);
    await store.githubConnections.connection(p, teamId);
    const team = (await store.teamFor(humanOf(p)))?.team;
    const ascii = (team?.name ?? '').replace(/[^A-Za-z0-9 ]/g, '').trim();
    const manifest = {
      // GitHub names are unique; a person may change it on GitHub's page.
      name: `Kinmesh ${ascii || teamId.slice(0, 8)}`.slice(0, 34),
      description: 'Kinmesh 的智能体用它开 PR，Kinmesh 用它读 PR 和 CI。',
      url: origin,
      redirect_url: origin + '/api/github/created',
      setup_url: origin + '/api/github/installed',
      setup_on_update: true,
      public: false,
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        checks: 'read',
        statuses: 'read',
        metadata: 'read',
      },
      default_events: [],
    };
    return GitHubManifest.parse({
      action: `${places.web}/settings/apps/new?state=${encodeURIComponent(stateFor(teamId, humanOf(p)))}`,
      manifest: JSON.stringify(manifest),
    });
  });

  // GitHub created the app: keep its key, then choose its repositories.
  app.get('/api/github/created', async (request, reply) => {
    const query = z
      .object({ code: z.string().min(1).max(100), state: z.string().max(400) })
      .safeParse(request.query);
    const step = query.success ? stepOf(query.data.state) : null;
    if (!query.success || step === null) return back(reply, true);
    const { teamId, person: p } = step;
    try {
      const created = await convertManifest(places.api, query.data.code);
      writeGitHubApp(directory, {
        appId: created.id,
        slug: created.slug,
        pem: created.pem,
      });
      await store.githubConnections.created(p, teamId, created.slug);
      return await reply.redirect(
        `${places.web}/apps/${created.slug}/installations/new?state=${encodeURIComponent(stateFor(teamId, humanOf(p)))}`,
      );
    } catch (error) {
      request.log.warn({ err: error }, 'github_app_creation_failed');
      return back(reply, true);
    }
  });

  // GitHub installed the app on repositories the person chose.
  app.get('/api/github/installed', async (request, reply) => {
    const query = z
      .object({
        installation_id: z.coerce.number().int().positive(),
        state: z.string().max(400).optional(),
      })
      .safeParse(request.query);
    const key = readGitHubApp(directory);
    if (!query.success || key === null) return back(reply, true);
    // Changing the repositories later on GitHub returns here without a
    // note: what it reaches is read from GitHub when the page opens.
    if (query.data.state === undefined) return back(reply, false);
    const step = stepOf(query.data.state);
    if (step === null) return back(reply, true);
    const { teamId, person: p } = step;
    try {
      const where = await installation(
        places.api,
        key,
        query.data.installation_id,
      );
      // Only an installation of the team's own app is taken.
      if (where.app_id !== key.appId) return await back(reply, true);
      await store.githubConnections.installed(
        p,
        teamId,
        where.id,
        where.account.login,
      );
      return await back(reply, false);
    } catch (error) {
      request.log.warn({ err: error }, 'github_installation_failed');
      return back(reply, true);
    }
  });
}
