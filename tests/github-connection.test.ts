import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { z } from 'zod';
import {
  GitHubManifest,
  GitHubStatus,
} from '../src/domain/github-connection.js';
import { readGitHubApp, managedDirectory } from '../src/runtime/managed.js';
import { githubTokens } from '../src/server/github.js';
import { githubPullRequests } from '../src/adapters/github/pull-requests.js';
import { agentFixture } from './agent-helpers.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const APP_ID = 4242;
const INSTALLATION = 777;

/** GitHub's API and pages as far as connecting a team goes. */
async function standIn() {
  const seen: { method: string; url: string; authorization: string }[] = [];
  /** The app's JWT verifies against the key GitHub handed over. */
  const appSigned = (r: IncomingMessage) => {
    const [header, payload, signature] = (r.headers.authorization ?? '')
      .replace(/^Bearer /, '')
      .split('.');
    if (!header || !payload || !signature) return false;
    const claims = z
      .object({ iss: z.string(), exp: z.number() })
      .parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    return (
      claims.iss === String(APP_ID) &&
      claims.exp > Date.now() / 1000 &&
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature, 'base64url'))
    );
  };
  /** GitHub's answer to one request: its status and JSON. */
  function answer(r: IncomingMessage, url: string): [number, unknown] {
    if (r.method === 'POST' && url === '/app-manifests/the-code/conversions')
      return [201, { id: APP_ID, slug: 'kinmesh-test', pem }];
    if (url === `/app/installations/${String(INSTALLATION)}`)
      return appSigned(r)
        ? [
            200,
            {
              id: INSTALLATION,
              app_id: APP_ID,
              account: { login: 'acme' },
              repository_selection: 'selected',
              html_url: 'https://github.example/settings/installations/777',
            },
          ]
        : [401, {}];
    if (url === '/app/installations/999')
      return [
        200,
        {
          id: 999,
          app_id: 1,
          account: { login: 'someone-else' },
          repository_selection: 'all',
          html_url: 'https://github.example/settings/installations/999',
        },
      ];
    if (
      r.method === 'POST' &&
      url === `/app/installations/${String(INSTALLATION)}/access_tokens`
    )
      return appSigned(r)
        ? [
            201,
            {
              token: 'installation-token',
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            },
          ]
        : [401, {}];
    if (url.startsWith('/installation/repositories'))
      return r.headers.authorization === 'Bearer installation-token'
        ? [
            200,
            {
              total_count: 2,
              repositories: [
                { full_name: 'acme/widgets' },
                { full_name: 'acme/gadgets' },
              ],
            },
          ]
        : [401, {}];
    return [404, {}];
  }
  const server = createServer((r, response) => {
    const url = r.url ?? '';
    seen.push({
      method: r.method ?? '',
      url,
      authorization: r.headers.authorization ?? '',
    });
    const [status, body] = answer(r, url);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${String(
    z.object({ port: z.number() }).parse(server.address()).port,
  )}`;
  return { origin, seen, close: () => server.close() };
}

await test('a person connects GitHub on its own pages, and the hub then reads GitHub as the team', async () => {
  const github = await standIn();
  const f = await agentFixture({
    github: { api: github.origin, web: github.origin },
  });
  try {
    const team = `/api/teams/${f.teamId}/github`;
    const status = async () =>
      GitHubStatus.parse(
        (
          await f.app.inject({ method: 'GET', url: team, cookies: f.cookies })
        ).json<unknown>(),
      );
    assert.deepEqual(await status(), { state: 'none' });
    // Agents never see or start it.
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: team + '/connect',
          headers: f.headers,
          payload: {},
        })
      ).statusCode,
      403,
    );

    // 1. The page posts the team's app to GitHub's "create" page.
    const started = GitHubManifest.parse(
      (
        await f.app.inject({
          method: 'POST',
          url: team + '/connect',
          cookies: f.cookies,
          payload: {},
        })
      ).json<unknown>(),
    );
    const action = new URL(started.action);
    assert.equal(
      action.origin + action.pathname,
      github.origin + '/settings/apps/new',
    );
    const state = action.searchParams.get('state') ?? '';
    const manifest = z
      .object({
        redirect_url: z.string(),
        setup_url: z.string(),
        public: z.boolean(),
        default_permissions: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(started.manifest));
    assert.equal(manifest.public, true);
    assert.deepEqual(manifest.default_permissions, {
      contents: 'write',
      pull_requests: 'write',
      checks: 'read',
      statuses: 'read',
      metadata: 'read',
    });
    assert.ok(manifest.redirect_url.endsWith('/api/github/created'));

    // A forged or stale note is turned away, and nothing is kept.
    const forged = await f.app.inject({
      method: 'GET',
      url: `/api/github/created?code=the-code&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`,
    });
    assert.equal(
      forged.headers.location,
      '/?settings=connections&github=failed',
    );
    assert.equal(readGitHubApp(managedDirectory(f.config.state)), null);

    // 2. GitHub sends the person back from its site: no session cookie
    // follows (SameSite=Strict); the note stands for them.
    const created = await f.app.inject({
      method: 'GET',
      url: `/api/github/created?code=the-code&state=${encodeURIComponent(state)}`,
    });
    const install = new URL(String(created.headers.location));
    assert.equal(
      install.origin + install.pathname,
      github.origin + '/apps/kinmesh-test/installations/new',
    );
    // The key is the hub's alone.
    assert.equal(readGitHubApp(managedDirectory(f.config.state))?.pem, pem);
    assert.equal((await status()).state, 'created');

    // An installation of another app is not taken.
    const foreign = await f.app.inject({
      method: 'GET',
      url: `/api/github/installed?installation_id=999&setup_action=install&state=${encodeURIComponent(install.searchParams.get('state') ?? '')}`,
    });
    assert.equal(
      foreign.headers.location,
      '/?settings=connections&github=failed',
    );

    // 3. Back from choosing repositories: connected.
    const installed = await f.app.inject({
      method: 'GET',
      url: `/api/github/installed?installation_id=${String(INSTALLATION)}&setup_action=install&state=${encodeURIComponent(install.searchParams.get('state') ?? '')}`,
    });
    assert.equal(installed.headers.location, '/?settings=connections');
    assert.deepEqual(await status(), {
      state: 'installed',
      account: 'acme',
      repositories: ['acme/widgets', 'acme/gadgets'],
      more: false,
      manageUrl: 'https://github.example/settings/installations/777',
    });
    // A later change of repositories on GitHub comes back without a note.
    assert.equal(
      (
        await f.app.inject({
          method: 'GET',
          url: `/api/github/installed?installation_id=${String(INSTALLATION)}&setup_action=update`,
        })
      ).headers.location,
      '/?settings=connections',
    );

    // The hub reads pull requests with the installation's token, minted
    // from the app's key and kept between reads.
    const tokens = githubTokens(f.store, managedDirectory(f.config.state), {
      api: github.origin,
      web: github.origin,
    });
    assert.equal(await tokens(), 'installation-token');
    const before = github.seen.filter((r) =>
      r.url.endsWith('/access_tokens'),
    ).length;
    await tokens();
    assert.equal(
      github.seen.filter((r) => r.url.endsWith('/access_tokens')).length,
      before,
      'kept, not minted again',
    );
    await githubPullRequests({ api: github.origin, token: tokens })(
      { repository: 'acme/widgets', number: 1 },
      new AbortController().signal,
    );
    assert.equal(
      github.seen.find((r) => r.url === '/repos/acme/widgets/pulls/1')
        ?.authorization,
      'Bearer installation-token',
    );
  } finally {
    await f.dispose();
    github.close();
  }
});
