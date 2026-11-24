import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TaskResult, type Task } from '../src/domain/tasks.js';
import { key } from './communication-helpers.js';
import { taskFixture } from './task-helpers.js';
import { connectGitHub } from './github-helpers.js';
import { connectTeam, startTeam, stop, call } from './team-mcp-helpers.js';
import { freePort } from './process-helpers.js';

const INSTALLATION = 777;
const sha = (value: unknown) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex');

/**
 * GitHub as far as opening a pull request goes: one repository the app is
 * installed on, its refs, commits, trees and pull requests, in memory.
 */
async function standIn() {
  const root = sha('root');
  const trees = new Map<string, Map<string, string>>([
    [
      root,
      new Map([
        ['README.md', '# Widgets\n'],
        ['old.txt', 'old\n'],
      ]),
    ],
  ]);
  const commits = new Map<
    string,
    { message: string; tree: string; parents: string[] }
  >([[sha('first'), { message: 'first', tree: root, parents: [] }]]);
  const refs = new Map([['main', sha('first')]]);
  const pulls: {
    number: number;
    head: string;
    base: string;
    title: string;
    body: string;
  }[] = [];
  const writes: string[] = [];
  /** The next pull request is made, but its answer never arrives. */
  let dropNextPull = false;
  const repo = '/repos/acme/widgets';
  async function bodyOf(r: IncomingMessage) {
    let text = '';
    r.setEncoding('utf8');
    for await (const chunk of r) text += String(chunk);
    const parsed: unknown = JSON.parse(text || 'null');
    return parsed;
  }
  async function answer(r: IncomingMessage): Promise<[number, unknown]> {
    const url = new URL(r.url ?? '', 'http://x');
    const path = url.pathname;
    if (r.method === 'POST') writes.push(path);
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
    if (!path.startsWith(repo)) return [404, {}];
    const rest = path.slice(repo.length);
    if (rest === '')
      return [
        200,
        {
          full_name: 'acme/widgets',
          default_branch: 'main',
          owner: { login: 'acme' },
        },
      ];
    if (r.method === 'GET' && rest.startsWith('/git/ref/heads/')) {
      const at = refs.get(
        decodeURIComponent(rest.slice('/git/ref/heads/'.length)),
      );
      return at === undefined ? [404, {}] : [200, { object: { sha: at } }];
    }
    if (r.method === 'GET' && rest.startsWith('/git/commits/')) {
      const id = rest.slice('/git/commits/'.length);
      const commit = commits.get(id);
      return commit === undefined
        ? [404, {}]
        : [
            200,
            { sha: id, message: commit.message, tree: { sha: commit.tree } },
          ];
    }
    if (r.method === 'POST' && rest === '/git/trees') {
      const asked = z
        .object({
          base_tree: z.string(),
          tree: z.array(
            z.object({
              path: z.string(),
              content: z.string().optional(),
              sha: z.null().optional(),
            }),
          ),
        })
        .parse(await bodyOf(r));
      const files = new Map(trees.get(asked.base_tree));
      for (const entry of asked.tree)
        if (entry.content === undefined) {
          if (!files.delete(entry.path)) return [422, {}];
        } else files.set(entry.path, entry.content);
      const id = sha([...files]);
      trees.set(id, files);
      return [201, { sha: id }];
    }
    if (r.method === 'POST' && rest === '/git/commits') {
      const asked = z
        .object({
          message: z.string(),
          tree: z.string(),
          parents: z.array(z.string()),
        })
        .parse(await bodyOf(r));
      const id = sha(asked);
      commits.set(id, asked);
      return [
        201,
        { sha: id, message: asked.message, tree: { sha: asked.tree } },
      ];
    }
    if (r.method === 'POST' && rest === '/git/refs') {
      const asked = z
        .object({ ref: z.string(), sha: z.string() })
        .parse(await bodyOf(r));
      const name = asked.ref.replace(/^refs\/heads\//, '');
      if (refs.has(name)) return [422, {}];
      refs.set(name, asked.sha);
      return [201, {}];
    }
    if (r.method === 'GET' && rest === '/pulls') {
      const head = url.searchParams.get('head');
      return [
        200,
        pulls
          .filter((p) => `acme:${p.head}` === head)
          .map((p) => ({ number: p.number })),
      ];
    }
    if (r.method === 'POST' && rest === '/pulls') {
      const asked = z
        .object({
          title: z.string(),
          head: z.string(),
          base: z.string(),
          body: z.string(),
        })
        .parse(await bodyOf(r));
      if (pulls.some((p) => p.head === asked.head)) return [422, {}];
      const pull = { number: pulls.length + 1, ...asked };
      pulls.push(pull);
      return [201, { number: pull.number }];
    }
    return [404, {}];
  }
  const server = createServer((r, response) => {
    void answer(r).then(([status, body]) => {
      if (
        dropNextPull &&
        r.method === 'POST' &&
        r.url === `${repo}/pulls` &&
        status === 201
      ) {
        dropNextPull = false;
        response.destroy();
        return;
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${String(
    z.object({ port: z.number() }).parse(server.address()).port,
  )}`;
  return {
    origin,
    writes,
    pulls,
    /** The files on a branch's head, and its commit's message. */
    branch(name: string) {
      const at = refs.get(name);
      const commit = at === undefined ? undefined : commits.get(at);
      return commit === undefined
        ? undefined
        : {
            message: commit.message,
            parents: commit.parents,
            files: Object.fromEntries(trees.get(commit.tree) ?? []),
          };
    },
    dropNextPull() {
      dropNextPull = true;
    },
    close: () => server.close(),
  };
}

/** A task the fixture's agent claimed: it is working on it. */
async function working(f: Awaited<ReturnType<typeof taskFixture>>) {
  const { task } = await f.create();
  return (await f.act(f.developer, task, { type: 'claim' })).task;
}
const change = (over: Record<string, unknown> = {}) => ({
  repository: 'acme/widgets',
  branch: 'agent/widget',
  title: 'Add the widget',
  body: 'It adds the widget.',
  files: [
    { path: 'src/widget.ts', content: 'export const widget = 1;\n' },
    { path: 'old.txt', content: null },
  ],
  ...over,
});

await test('the agent working on a task opens its change as a pull request in Kinmesh name, linked to the task, once', async () => {
  const github = await standIn();
  const f = await taskFixture({
    github: { api: github.origin, web: github.origin },
  });
  try {
    const task = await working(f);
    const open = (
      body: object,
      auth: object = { headers: f.developerHeaders },
      on: Task = task,
    ) =>
      f.app.inject({
        method: 'POST',
        url: `${f.taskPath}/${on.id}/open-pull-request`,
        ...auth,
        payload: body,
      });
    const asked = (over: Record<string, unknown> = {}) => ({
      operationKey: key(),
      expectedVersion: task.version,
      ...change(over),
    });
    const refusal = (r: Awaited<ReturnType<typeof open>>) => ({
      status: r.statusCode,
      reason: z.object({ reason: z.string().optional() }).parse(r.json())
        .reason,
    });

    // Nothing is asked of GitHub before the team connected it.
    assert.deepEqual(refusal(await open(asked())), {
      status: 409,
      reason: 'github-not-connected',
    });
    assert.equal(github.writes.length, 0);
    await connectGitHub(f, INSTALLATION);

    // Only the agent working on it, while it is worked on, may: never a
    // person (they open their own), another agent, or a task not started.
    assert.equal((await open(asked(), { cookies: f.cookies })).statusCode, 403);
    assert.equal(
      (await open(asked(), { headers: f.reviewerHeaders })).statusCode,
      403,
    );
    const { task: proposed } = await f.create();
    assert.equal(
      (
        await open(
          { ...asked(), expectedVersion: proposed.version },
          undefined,
          proposed,
        )
      ).statusCode,
      403,
    );
    // A repository the app is not installed on, or a missing base.
    assert.deepEqual(
      refusal(await open(asked({ repository: 'acme/elsewhere' }))),
      { status: 403, reason: 'repository-not-connected' },
    );
    assert.deepEqual(refusal(await open(asked({ base: 'nope' }))), {
      status: 409,
      reason: 'base-missing',
    });
    // A change past what a commit may carry, or a path outside the tree.
    for (const files of [
      [{ path: 'big.txt', content: 'x'.repeat(1024 * 1024 + 1) }],
      [{ path: '../escape', content: '' }],
      [{ path: '.git/config', content: '' }],
    ])
      assert.equal((await open(asked({ files }))).statusCode, 400);
    assert.deepEqual(
      github.writes.filter((w) => !w.endsWith('/access_tokens')),
      [],
      'nothing written on GitHub',
    );

    // Opened: one commit on a new branch, a pull request, linked.
    const body = asked();
    const first = await open(body);
    assert.equal(first.statusCode, 200);
    const result = TaskResult.parse(first.json());
    assert.deepEqual(result.pullRequestLink?.pullRequest, {
      repository: 'acme/widgets',
      number: 1,
    });
    assert.equal(result.task.state.status, 'in-progress');
    assert.equal(result.task.version, task.version + 1);
    const made = github.branch('agent/widget');
    assert.ok(made);
    assert.deepEqual(made.files, {
      'README.md': '# Widgets\n',
      'src/widget.ts': 'export const widget = 1;\n',
    });
    assert.deepEqual(made.parents, [sha('first')]);
    // It says whose change for which task, naming no person.
    assert.match(made.message, /^Add the widget\n/);
    assert.ok(made.message.includes(`Kinmesh-Task: ${task.id}`));
    assert.ok(
      made.message.includes(
        `Co-authored-by: ${f.agent.name} <agent-${f.agent.id}@kinmesh.invalid>`,
      ),
    );
    const [pull] = github.pulls;
    assert.ok(pull);
    assert.equal(pull.base, 'main');
    assert.ok(pull.body.startsWith('It adds the widget.\n\n---\n'));
    assert.ok(pull.body.includes(f.agent.name));
    assert.ok(pull.body.includes(`task=${task.id}`));
    // The task says it once, as the agent's.
    const linked = await f.tasks.pullRequests(
      f.principal,
      f.teamId,
      f.channelId,
      task.id,
    );
    assert.equal(linked.length, 1);
    assert.equal(linked[0]?.author.kind, 'agent');

    // A lost reply, asked again: the same answer, nothing more on GitHub.
    const before = github.writes.length;
    const again = await open(body);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(TaskResult.parse(again.json()), result);
    assert.equal(github.writes.length, before);
    // The same key for something else is refused.
    assert.equal((await open({ ...body, title: 'Another' })).statusCode, 409);
    // The branch is this change's: another change never writes to it.
    assert.deepEqual(
      refusal(
        await open({
          ...asked({ title: 'Another' }),
          expectedVersion: result.task.version,
        }),
      ),
      { status: 409, reason: 'branch-taken' },
    );
    assert.equal(github.pulls.length, 1);
  } finally {
    await f.dispose();
    github.close();
  }
});

await test('when GitHub opened the pull request but its answer was lost, asking again links that one', async () => {
  const github = await standIn();
  const f = await taskFixture({
    github: { api: github.origin, web: github.origin },
  });
  try {
    await connectGitHub(f, INSTALLATION);
    const task = await working(f);
    const body = {
      operationKey: key(),
      expectedVersion: task.version,
      ...change(),
    };
    const open = () =>
      f.app.inject({
        method: 'POST',
        url: `${f.taskPath}/${task.id}/open-pull-request`,
        headers: f.developerHeaders,
        payload: body,
      });
    github.dropNextPull();
    assert.equal((await open()).statusCode, 500);
    assert.equal(github.pulls.length, 1, 'GitHub opened it');
    const retried = await open();
    assert.equal(retried.statusCode, 200);
    assert.deepEqual(
      TaskResult.parse(retried.json()).pullRequestLink?.pullRequest,
      { repository: 'acme/widgets', number: 1 },
    );
    assert.equal(github.pulls.length, 1, 'never a second one');
  } finally {
    await f.dispose();
    github.close();
  }
});

await test('Team MCP asks the hub to open it, as the agent, and passes on why not', async () => {
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
    const task = await working(f);
    const tools = await client.listTools();
    assert.ok(
      tools.tools.some((t) => t.name === 'team_task_open_pull_request'),
    );
    const result = await call(
      client,
      'team_task_open_pull_request',
      {
        channelId: f.channelId,
        taskId: task.id,
        operationKey: key(),
        expectedVersion: task.version,
        ...change(),
      },
      TaskResult,
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
