import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TaskResult, type TaskEvent } from '../src/domain/tasks.js';
import {
  PullRequestObservation,
  TaskPullRequestView,
  pullRequestFromUrl,
  pullRequestKey,
  pullRequestStale,
  askAgainAfter,
  commitChecks,
  PULL_REQUEST_FRESH_MS,
} from '../src/domain/pull-requests.js';
import { githubPullRequests } from '../src/adapters/github/pull-requests.js';
import { key } from './communication-helpers.js';
import { taskFixture } from './task-helpers.js';
import { feishuPerson, signInAs } from './feishu.js';

const sha = 'a'.repeat(40);
const observed = (over: Partial<PullRequestObservation> = {}) =>
  PullRequestObservation.parse({
    kind: 'observed',
    repository: 'Acme/Widgets',
    number: 7,
    title: 'Add the widget',
    state: 'open',
    draft: false,
    url: 'https://github.com/Acme/Widgets/pull/7',
    headRef: 'widget',
    headSha: sha,
    baseRef: 'main',
    observedAt: new Date().toISOString(),
    ...over,
  });

await test('a PR address names one pull request; nothing else is read as one', () => {
  assert.deepEqual(
    pullRequestFromUrl('https://github.com/Acme/Widgets/pull/7/files?w=1#x'),
    { repository: 'Acme/Widgets', number: 7 },
  );
  for (const text of [
    'http://github.com/Acme/Widgets/pull/7',
    'https://github.example.com/Acme/Widgets/pull/7',
    'https://github.com/Acme/Widgets/issues/7',
    'https://github.com/Acme/Widgets/pull/0',
    'https://github.com/Acme/Widgets/pull/7x',
    'https://github.com/-bad/Widgets/pull/7',
    'https://github.com/Acme/../pull/7',
    'not a url',
  ])
    assert.equal(pullRequestFromUrl(text), null, text);
  // One pull request however its repository is cased.
  assert.equal(
    pullRequestKey({ repository: 'Acme/Widgets', number: 7 }),
    pullRequestKey({ repository: 'acme/widgets', number: 7 }),
  );
  // Checks sum to one state: any failure fails, else anything running is
  // pending, else any pass passes; none at all is not a pass.
  const read = new Date().toISOString();
  const state = (o: Parameters<typeof commitChecks>[1]) => {
    const c = commitChecks(sha, o, read);
    return c.kind === 'observed' ? c.state : c.kind;
  };
  assert.equal(state(['passed', 'pending', 'failed']), 'failing');
  assert.equal(state(['passed', 'pending']), 'pending');
  assert.equal(state(['passed', 'passed']), 'passing');
  assert.equal(state([]), 'none');
  // An answer is stale only after three missed askings, by its state.
  const now = Date.now();
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(
    pullRequestStale(
      observed({ observedAt: at(PULL_REQUEST_FRESH_MS.open) }),
      now,
    ),
    false,
  );
  assert.equal(
    pullRequestStale(
      observed({ observedAt: at(4 * PULL_REQUEST_FRESH_MS.open) }),
      now,
    ),
    true,
  );
  assert.equal(
    pullRequestStale(
      observed({
        state: 'merged',
        observedAt: at(4 * PULL_REQUEST_FRESH_MS.open),
      }),
      now,
    ),
    false,
  );
});

await test('linking a PR to a task is attributed, idempotent, once per PR, and changes no responsibility', async () => {
  const f = await taskFixture();
  try {
    const created = await f.create();
    const task = created.task;
    const path = `${f.taskPath}/${task.id}`;
    const link = (
      pullRequest: object,
      expectedVersion: number,
      operationKey = key(),
      auth: object = { cookies: f.cookies },
    ) =>
      f.app.inject({
        method: 'POST',
        url: path + '/link-pull-request',
        ...auth,
        payload: { operationKey, expectedVersion, pullRequest },
      });
    const operationKey = key();
    const first = await link(
      { repository: 'Acme/Widgets', number: 7 },
      1,
      operationKey,
    );
    assert.equal(first.statusCode, 200);
    const result = TaskResult.parse(first.json<unknown>());
    assert.equal(result.task.state.status, 'proposed');
    assert.equal(result.task.version, 2);
    assert.ok(result.pullRequestLink);
    assert.deepEqual(result.pullRequestLink.pullRequest, {
      repository: 'Acme/Widgets',
      number: 7,
    });
    assert.deepEqual(result.pullRequestLink.author, {
      kind: 'human',
      humanId: f.principal.humanId,
    });
    // A lost reply retried replays; the same key with other input conflicts.
    const again = await link(
      { repository: 'Acme/Widgets', number: 7 },
      1,
      operationKey,
    );
    assert.equal(again.statusCode, 200);
    assert.deepEqual(TaskResult.parse(again.json<unknown>()), result);
    assert.equal(
      (await link({ repository: 'Acme/Widgets', number: 8 }, 1, operationKey))
        .statusCode,
      409,
    );
    // The same PR, however cased, is linked once.
    assert.equal(
      (await link({ repository: 'acme/widgets', number: 7 }, 2)).statusCode,
      409,
    );
    // An agent that may write the channel's tasks links too, as itself.
    const byAgent = await link(
      { repository: 'Acme/Widgets', number: 9 },
      2,
      key(),
      { headers: f.developerHeaders },
    );
    assert.equal(byAgent.statusCode, 200);
    assert.equal(
      TaskResult.parse(byAgent.json<unknown>()).pullRequestLink?.author.kind,
      'agent',
    );
    // Someone who left the channel cannot link (a newcomer joins it first).
    const newcomer = await signInAs(f.app, 'newcomer@example.com');
    const left = await f.store.signIn(feishuPerson('newcomer@example.com'));
    await f.store.channels.membership(
      { kind: 'human', humanId: left.id },
      f.teamId,
      f.channelId,
      { operationKey: key() },
      'leave',
    );
    const refused = await link(
      { repository: 'Acme/Widgets', number: 10 },
      3,
      key(),
      { cookies: newcomer },
    );
    assert.equal(refused.statusCode, 404);
    // Read back: both links, oldest first, nothing GitHub said yet.
    const listed = z.array(TaskPullRequestView).parse(
      (
        await f.app.inject({
          method: 'GET',
          url: path + '/pull-requests',
          cookies: f.cookies,
        })
      ).json<unknown>(),
    );
    assert.deepEqual(
      listed.map((l) => l.pullRequest.number),
      [7, 9],
    );
    // History says it, and no agent or person was woken or asked.
    const history = await f.tasks.history(
      f.principal,
      f.teamId,
      f.channelId,
      task.id,
    );
    assert.deepEqual(
      history.items.map((e: z.infer<typeof TaskEvent>) => e.action),
      ['create', 'link-pull-request', 'link-pull-request'],
    );
    // An ended task takes no new link.
    const cancelled = await f.act(
      f.principal,
      await f.tasks.get(f.principal, f.teamId, f.channelId, task.id),
      {
        type: 'cancel',
        note: 'Not needed',
      },
    );
    assert.equal(cancelled.task.state.status, 'cancelled');
    assert.equal(
      (
        await link(
          { repository: 'Acme/Widgets', number: 11 },
          cancelled.task.version,
        )
      ).statusCode,
      409,
    );
    // What is linked stays readable after it ends.
    assert.equal(
      (await f.tasks.pullRequests(f.principal, f.teamId, f.channelId, task.id))
        .length,
      2,
    );
  } finally {
    await f.dispose();
  }
});

await test('what GitHub said is kept per PR: a passing failure keeps the last answer, a definite one replaces it', async () => {
  const f = await taskFixture();
  try {
    const task = (await f.create()).task;
    await f.act(f.principal, task, {
      type: 'link-pull-request',
      pullRequest: { repository: 'Acme/Widgets', number: 7 },
    });
    const pullKey = 'acme/widgets#7';
    const observations = f.store.githubObservations;
    const now = Date.now();
    // A new link is due at once.
    assert.deepEqual(
      (await observations.due(now, 20)).map((d) => d.pullKey),
      [pullKey],
    );
    const seen = observed({ state: 'merged' });
    await observations.observe(pullKey, seen, now);
    // Answered: not due again until a merged PR's interval passes.
    assert.deepEqual(await observations.due(now + 60_000, 20), []);
    assert.equal(
      (await observations.due(now + PULL_REQUEST_FRESH_MS.settled, 20)).length,
      1,
    );
    const read = async () =>
      (
        await f.tasks.pullRequests(f.principal, f.teamId, f.channelId, task.id)
      )[0]?.observation;
    assert.deepEqual(await read(), seen);
    // GitHub unreachable: the last answer stays, and shows its age.
    await observations.observe(
      pullKey,
      PullRequestObservation.parse({
        kind: 'unavailable',
        reason: 'unreachable',
        observedAt: new Date().toISOString(),
      }),
      now + 1,
    );
    assert.deepEqual(await read(), seen);
    // GitHub says there is no such PR: that is the answer now.
    const gone = PullRequestObservation.parse({
      kind: 'unavailable',
      reason: 'not-found',
      observedAt: new Date().toISOString(),
    });
    await observations.observe(pullKey, gone, now + 2);
    assert.deepEqual(await read(), gone);
  } finally {
    await f.dispose();
  }
});

await test('GitHub is read at the address the PR names, with the token when there is one, and every failure is said', async () => {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  let reply: (url: string) => {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  } = () => ({ status: 500 });
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? '', headers: request.headers });
    const r = reply(request.url ?? '');
    response.writeHead(r.status, {
      'content-type': 'application/json',
      ...r.headers,
    });
    response.end(r.body === undefined ? '' : JSON.stringify(r.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = `http://127.0.0.1:${String(z.object({ port: z.number() }).parse(server.address()).port)}`;
  const directory = (await import('node:fs')).mkdtempSync(
    join((await import('node:os')).tmpdir(), 'kinmesh-github-'),
  );
  const tokenFile = join(directory, 'token');
  writeFileSync(tokenFile, 'read-only-token\n', { mode: 0o600 });
  const signal = new AbortController().signal;
  const ref = { repository: 'Acme/Widgets', number: 7 };
  try {
    const pull = {
      number: 7,
      title: 'Add the widget',
      state: 'closed',
      draft: false,
      merged_at: '2026-11-20T10:00:00Z',
      html_url: 'https://github.com/Acme/Widgets/pull/7',
      head: { ref: 'widget', sha },
      base: { ref: 'main', repo: { full_name: 'Acme/Widgets' } },
    };
    // The head commit's checks: two check runs and one commit status.
    let runs: { status: string; conclusion: string | null }[] = [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' },
    ];
    let statuses = [{ state: 'success' }];
    let checksStatus = 200;
    const github = (body: unknown) => (url: string) =>
      url.includes('/check-runs')
        ? { status: checksStatus, body: { check_runs: runs } }
        : url.includes('/status')
          ? { status: checksStatus, body: { statuses } }
          : { status: 200, body };
    reply = github(pull);
    const withToken = githubPullRequests({ api, tokenFile });
    const merged = await withToken(ref, signal);
    assert.ok(merged.kind === 'observed');
    assert.equal(merged.state, 'merged');
    assert.equal(seen.at(0)?.url, '/repos/Acme/Widgets/pulls/7');
    assert.equal(seen.at(0)?.headers.authorization, 'Bearer read-only-token');
    // Its checks are its head commit's, read with it.
    assert.deepEqual(
      seen
        .slice(1, 3)
        .map((r) => r.url.split('?')[0])
        .sort(),
      [
        `/repos/Acme/Widgets/commits/${sha}/check-runs`,
        `/repos/Acme/Widgets/commits/${sha}/status`,
      ],
    );
    assert.ok(merged.checks?.kind === 'observed');
    assert.equal(merged.checks.sha, sha);
    assert.equal(merged.checks.state, 'passing');
    assert.equal(merged.checks.passed, 3);
    // Without a token, Kinmesh reads as an anonymous visitor would.
    const before = seen.length;
    await githubPullRequests({ api, tokenFile: null })(ref, signal);
    assert.ok(
      seen.slice(before).every((r) => r.headers.authorization === undefined),
    );
    // A check still running, then one failed, then none at all.
    runs = [{ status: 'in_progress', conclusion: null }];
    statuses = [];
    const running = await withToken(ref, signal);
    assert.ok(
      running.kind === 'observed' && running.checks?.kind === 'observed',
    );
    assert.equal(running.checks.state, 'pending');
    assert.equal(askAgainAfter(running), PULL_REQUEST_FRESH_MS.checking);
    runs = [
      { status: 'in_progress', conclusion: null },
      { status: 'completed', conclusion: 'failure' },
    ];
    const failing = await withToken(ref, signal);
    assert.ok(
      failing.kind === 'observed' && failing.checks?.kind === 'observed',
    );
    assert.equal(failing.checks.state, 'failing');
    runs = [];
    const bare = await withToken(ref, signal);
    assert.ok(bare.kind === 'observed' && bare.checks?.kind === 'observed');
    assert.equal(bare.checks.state, 'none', 'no checks is not a pass');
    // Checks GitHub won't show: the pull request is still read.
    checksStatus = 403;
    const hidden = await withToken(ref, signal);
    assert.ok(
      hidden.kind === 'observed' && hidden.checks?.kind === 'unavailable',
    );
    assert.equal(hidden.checks.reason, 'forbidden');
    checksStatus = 200;
    reply = github({ ...pull, state: 'open', merged_at: null, draft: true });
    const draft = await withToken(ref, signal);
    assert.ok(
      draft.kind === 'observed' && draft.state === 'open' && draft.draft,
    );
    const reason = async (status: number, headers = {}) => {
      reply = () => ({ status, headers, body: { message: 'no' } });
      const o = await withToken(ref, signal);
      return o.kind === 'unavailable' ? o.reason : o.kind;
    };
    assert.equal(await reason(404), 'not-found');
    assert.equal(await reason(401), 'forbidden');
    assert.equal(await reason(403), 'forbidden');
    assert.equal(
      await reason(403, { 'x-ratelimit-remaining': '0' }),
      'rate-limited',
    );
    assert.equal(await reason(429, { 'retry-after': '60' }), 'rate-limited');
    assert.equal(await reason(502), 'unreachable');
    reply = () => ({ status: 200, body: { unexpected: true } });
    assert.equal((await withToken(ref, signal)).kind, 'unavailable');
    // Nothing answering at all.
    const nowhere = githubPullRequests({
      api: 'http://127.0.0.1:9',
      tokenFile: null,
    });
    const down = await nowhere(ref, signal);
    assert.ok(down.kind === 'unavailable' && down.reason === 'unreachable');
  } finally {
    server.close();
    (await import('node:fs')).rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

await test('the open task carries its PRs in the workspace, so a new link reaches the open page', async () => {
  const f = await taskFixture();
  try {
    const task = (await f.create()).task;
    await f.act(f.principal, task, {
      type: 'link-pull-request',
      pullRequest: { repository: 'Acme/Widgets', number: 7 },
    });
    const snapshot = z
      .object({ taskPullRequests: z.array(TaskPullRequestView) })
      .parse(
        (
          await f.app.inject({
            method: 'GET',
            url: `/api/workspace?channelId=${f.channelId}&taskId=${task.id}`,
            cookies: f.cookies,
          })
        ).json<unknown>(),
      );
    assert.deepEqual(
      snapshot.taskPullRequests.map((l) => l.pullRequest),
      [{ repository: 'Acme/Widgets', number: 7 }],
    );
    // Without an open task, the workspace carries none.
    const none = z
      .object({ taskPullRequests: z.array(TaskPullRequestView) })
      .parse(
        (
          await f.app.inject({
            method: 'GET',
            url: `/api/workspace?channelId=${f.channelId}`,
            cookies: f.cookies,
          })
        ).json<unknown>(),
      );
    assert.deepEqual(none.taskPullRequests, []);
  } finally {
    await f.dispose();
  }
});
