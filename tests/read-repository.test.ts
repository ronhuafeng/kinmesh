import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { RepositoryContent } from '../src/domain/repository.js';
import { taskFixture } from './task-helpers.js';
import { connectGitHub } from './github-helpers.js';
import { connectTeam, startTeam, stop, call } from './team-mcp-helpers.js';
import { freePort } from './process-helpers.js';

const INSTALLATION = 778;
const MAIN = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

/**
 * GitHub as far as reading goes: one repository the app is installed on,
 * two commits, and what the contents API says of each path at each.
 */
async function standIn() {
  const files: Record<string, Record<string, unknown>> = {
    [MAIN]: {
      'README.md': {
        type: 'file',
        size: 10,
        encoding: 'base64',
        content: Buffer.from('# Widgets\n').toString('base64'),
      },
      'logo.png': {
        type: 'file',
        size: 4,
        encoding: 'base64',
        content: Buffer.from([0x89, 0x50, 0x00, 0xff]).toString('base64'),
      },
      // Past a megabyte GitHub leaves the content out.
      'big.txt': {
        type: 'file',
        size: 2_000_000,
        encoding: 'none',
        content: '',
      },
      link: { type: 'symlink', size: 9, target: 'README.md' },
      '': [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'dir' },
        { name: 'link', type: 'symlink' },
      ],
    },
    [OLD]: {
      'README.md': {
        type: 'file',
        size: 6,
        encoding: 'base64',
        content: Buffer.from('# Old\n').toString('base64'),
      },
    },
  };
  const refs: Record<string, string> = { main: MAIN, old: OLD, [OLD]: OLD };
  const asked: string[] = [];
  const repo = '/repos/acme/widgets';
  function answer(r: IncomingMessage): [number, unknown] {
    const url = new URL(r.url ?? '', 'http://x');
    const path = url.pathname;
    asked.push(`${r.method ?? ''} ${path}`);
    if (
      r.method === 'POST' &&
      path === `/app/installations/${String(INSTALLATION)}/access_tokens`
    )
      return [
        201,
        {
          token: 'installation-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      ];
    if (r.headers.authorization !== 'Bearer installation-token')
      return [401, {}];
    if (r.method !== 'GET' || !path.startsWith(repo)) return [404, {}];
    const rest = path.slice(repo.length);
    if (rest === '')
      return [200, { full_name: 'acme/widgets', default_branch: 'main' }];
    if (rest.startsWith('/commits/')) {
      const at = refs[decodeURIComponent(rest.slice('/commits/'.length))];
      return at === undefined ? [422, {}] : [200, { sha: at }];
    }
    if (rest === '/contents' || rest.startsWith('/contents/')) {
      const at = files[url.searchParams.get('ref') ?? ''] ?? {};
      const found = at[decodeURIComponent(rest.slice('/contents/'.length))];
      return found === undefined ? [404, {}] : [200, found];
    }
    return [404, {}];
  }
  const server = createServer((r, response) => {
    const [status, body] = answer(r);
    r.resume();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${String(
      z.object({ port: z.number() }).parse(server.address()).port,
    )}`,
    asked,
    close: () => server.close(),
  };
}

/**
 * Proves the agent working on a task reads the repository it changes as the
 * team's app: a file's text and a directory's entries at the default branch
 * or another ref; only that agent; nothing before GitHub is connected; and
 * every refusal names what to change, writing nothing on GitHub.
 */
await test('the agent working on a task reads its repository as the team’s app, and nobody else does', async () => {
  const github = await standIn();
  const f = await taskFixture({
    github: { api: github.origin, web: github.origin },
  });
  try {
    const { task: proposed } = await f.create();
    const task = (await f.act(f.developer, proposed, { type: 'claim' })).task;
    const read = (
      body: object,
      auth: object = { headers: f.developerHeaders },
      on = task,
    ) =>
      f.app.inject({
        method: 'POST',
        url: `${f.taskPath}/${on.id}/read-repository`,
        ...auth,
        payload: { repository: 'acme/widgets', ...body },
      });
    const refusal = async (body: object) => {
      const r = await read(body);
      return {
        status: r.statusCode,
        reason: z.object({ reason: z.string().optional() }).parse(r.json())
          .reason,
      };
    };
    // Nothing is asked of GitHub before the team connected it.
    assert.deepEqual(await refusal({ path: 'README.md' }), {
      status: 409,
      reason: 'github-not-connected',
    });
    assert.equal(github.asked.length, 0);
    await connectGitHub(f, INSTALLATION);

    // A file's text, at the default branch, with the commit it was read at.
    const readme = await read({ path: 'README.md' });
    assert.equal(readme.statusCode, 200);
    assert.deepEqual(RepositoryContent.parse(readme.json()), {
      kind: 'file',
      repository: 'acme/widgets',
      commit: MAIN,
      path: 'README.md',
      text: '# Widgets\n',
    });
    // Another branch, or a commit.
    for (const ref of ['old', OLD])
      assert.deepEqual(
        RepositoryContent.parse(
          (await read({ ref, path: 'README.md' })).json(),
        ),
        {
          kind: 'file',
          repository: 'acme/widgets',
          commit: OLD,
          path: 'README.md',
          text: '# Old\n',
        },
      );
    // The top directory's entries.
    assert.deepEqual(RepositoryContent.parse((await read({})).json()), {
      kind: 'directory',
      repository: 'acme/widgets',
      commit: MAIN,
      path: '',
      entries: [
        { name: 'README.md', kind: 'file' },
        { name: 'src', kind: 'directory' },
        { name: 'link', kind: 'other' },
      ],
    });

    // Only the agent working on it: never a person, another agent, or a
    // task nobody has taken.
    assert.equal((await read({}, { cookies: f.cookies })).statusCode, 403);
    assert.equal(
      (await read({}, { headers: f.reviewerHeaders })).statusCode,
      403,
    );
    const { task: untaken } = await f.create();
    assert.equal((await read({}, undefined, untaken)).statusCode, 403);

    // What to change, when it cannot be read.
    assert.deepEqual(await refusal({ repository: 'acme/elsewhere' }), {
      status: 403,
      reason: 'repository-not-connected',
    });
    assert.deepEqual(await refusal({ ref: 'nope' }), {
      status: 404,
      reason: 'ref-missing',
    });
    assert.deepEqual(await refusal({ path: 'missing.txt' }), {
      status: 404,
      reason: 'path-missing',
    });
    assert.deepEqual(await refusal({ path: 'logo.png' }), {
      status: 400,
      reason: 'not-text',
    });
    assert.deepEqual(await refusal({ path: 'link' }), {
      status: 400,
      reason: 'not-text',
    });
    assert.deepEqual(await refusal({ path: 'big.txt' }), {
      status: 413,
      reason: 'too-large',
    });
    // A path outside the tree is not asked of GitHub at all.
    for (const path of ['../escape', '.git/config', '/etc/passwd'])
      assert.equal((await read({ path })).statusCode, 400);

    // Reading writes nothing: the only POST is the app's own token.
    assert.deepEqual(
      github.asked.filter((a) => !a.startsWith('GET ')),
      [`POST /app/installations/${String(INSTALLATION)}/access_tokens`],
    );
  } finally {
    await f.dispose();
    github.close();
  }
});

await test('Team MCP reads through the hub, as the agent, read-only, and passes on why not', async () => {
  const f = await taskFixture();
  const port = await freePort();
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const hub = `http://127.0.0.1:${String(
    z.object({ port: z.number() }).parse(f.app.server.address()).port,
  )}`;
  const team = await startTeam(f.dbPath, port, {
    ...f.filesEnv,
    KINMESH_ORIGIN: hub,
  });
  const { client } = await connectTeam(
    `http://127.0.0.1:${String(port)}/mcp`,
    f.developerGrant.token,
  );
  try {
    const { task: proposed } = await f.create();
    const task = (await f.act(f.developer, proposed, { type: 'claim' })).task;
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === 'team_task_read_repository',
    );
    assert.equal(tool?.annotations?.readOnlyHint, true);
    const result = await call(
      client,
      'team_task_read_repository',
      {
        channelId: f.channelId,
        taskId: task.id,
        repository: 'acme/widgets',
        path: 'README.md',
      },
      RepositoryContent,
    );
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'conflict',
        message: 'Operation conflicts',
        reason: 'github-not-connected',
      },
    });
  } finally {
    await client.close();
    await stop(team);
    await f.dispose();
  }
});
