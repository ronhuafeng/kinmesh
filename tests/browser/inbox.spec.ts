import { createHash, randomUUID } from 'node:crypto';
import { rawDatabase } from '../raw.js';
import { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { saveCredential } from '../../src/adapters/t3/oauth.js';
import { managedDirectory, t3AuthFile } from '../../src/runtime/managed.js';
import { test, expect } from './fixture.js';
import { createChannel, refreshNow, register, signIn } from './ui.js';
import { snapshot, withoutStream, readAgain } from './helpers.js';

test('the Inbox gathers what waits on me across channels and leads to the fix', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  // What the Inbox lists, and when: tests/attention.test.ts.
  const needs = page
    .getByRole('navigation', { name: '收件箱' })
    .getByRole('button', { name: /^收件箱/ });
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill('@Ada please check the release notes');
  await composer.getByRole('button', { name: '发送消息' }).click();
  // Ada has no worker: queued work leads to setting Ada up.
  await createChannel(page, 'launch');
  await needs.click();
  const inbox = page.getByRole('region', { name: '收件箱' });
  await inbox
    .getByRole('button', {
      name: /1 条请求在等待，但还无法唤醒 Ada/,
    })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Ada', exact: true })
      .getByRole('group', { name: '连接 T3' }),
  ).toBeVisible();
  // A blocking failure turns it into something to unstick, wherever I am.
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        "UPDATE agent_inbox SET state = 'blocked', reason = 'authority-or-contract-blocked'",
      )
      .run();
  } finally {
    await sql.close();
  }
  await page.keyboard.press('Escape');
  await needs.click();
  await inbox.getByRole('button', { name: /Ada 卡住了/ }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(
    page
      .getByRole('list', { name: '频道消息' })
      .getByText('please check the release notes'),
  ).toBeVisible();
});

test('a stuck request says what was lost and is fixed and retried in place', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada || !state.channel) throw new Error('Local fixture unavailable');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill('@Ada please check the release notes');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const responses = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'please check the release notes' })
    .first()
    .getByRole('list', { name: '智能体响应' });
  // Each cause's sentence: tests/delivery-copy.test.ts.
  await expect(responses).toContainText('Ada');
  // Ada is removed from the channel; the worker records that as the cause.
  const removed = await context.request.post(
    `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/participants/remove`,
    {
      data: {
        operationKey: randomUUID(),
        member: { kind: 'agent', id: ada.id },
      },
    },
  );
  expect(removed.status()).toBe(200);
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        "UPDATE agent_inbox SET state = 'blocked', reason = 'not-in-channel'",
      )
      .run();
  } finally {
    await sql.close();
  }
  await expect(responses).toContainText('Ada 已被移出频道，这条请求暂停了');
  await expect(responses.getByText(/npm run/)).toHaveCount(0);
  await responses
    .getByRole('button', { name: '把 Ada 加回频道并重试', exact: true })
    .click();
  // Back in the channel and retried with the original request.
  await expect
    .poll(
      async () => (await snapshot(context.request, hub.origin)).deliveries[0],
    )
    .toMatchObject({ state: 'uncertain', reason: 'owner-resume' });
  expect(
    (await snapshot(context.request, hub.origin)).joinedAgentIds,
  ).toContain(ada.id);
  // A cause fixed elsewhere leads there and offers a plain retry.
  const db = rawDatabase(hub.database);
  try {
    await db
      .prepare(
        "UPDATE agent_inbox SET state = 'blocked', reason = 'credential-invalid'",
      )
      .run();
  } finally {
    await db.close();
  }
  await expect(
    responses.getByRole('button', { name: '重试', exact: true }),
  ).toBeVisible();
  await responses
    .getByRole('button', { name: '修复 Ada 的配置', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Ada', exact: true })
      .getByRole('button', { name: '连接 T3', exact: true }),
  ).toBeVisible();
});

test('a request waiting for an approval in T3 is stopped from its line, and one not yet sent ends at once', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const say = async (text: string) => {
    await composer.getByLabel('消息', { exact: true }).fill(text);
    await composer.getByRole('button', { name: '发送消息' }).click();
  };
  const responses = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text })
      .first()
      .getByRole('list', { name: '智能体响应' });
  // Nothing has reached T3: stopping ends it at once.
  await say('@Ada please check the release notes');
  const unsent = responses('please check the release notes');
  await expect(unsent).toContainText('Ada 离线');
  await unsent.getByRole('button', { name: '停止', exact: true }).click();
  await expect(unsent).toContainText('Ada 开始前已停止');
  await expect(unsent.getByRole('button', { name: '停止' })).toHaveCount(0);
  // The next one's run waits for an approval in T3, as the worker records
  // it, in the team's T3. MOCK only: no T3 is reached; the link is the
  // thread on the team's T3 origin.
  await say('@Ada and the changelog?');
  const waiting = responses('and the changelog?');
  await expect(waiting).toContainText('Ada 离线');
  const thread = 'http://127.0.0.1:3773/env-mock/thread-mock';
  await page.route('**/api/teams/*/deliveries/*/link', (route) =>
    route.fulfill({ json: { url: thread } }),
  );
  const team = (await snapshot(context.request, hub.origin)).team.id;
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        "UPDATE agent_inbox SET state = 'waiting', reason = 'human-or-approval-wait', reference = ? WHERE state = 'ready'",
      )
      .run(
        JSON.stringify({
          backend: 't3',
          environmentId: 'env-mock',
          threadId: 'thread-mock',
          runId: 'run-mock',
        }),
      );
    await sql
      .prepare(
        'INSERT INTO t3_connections (team_id, endpoint, environment_id, connected_at) VALUES (?, ?, ?, ?)',
      )
      .run(team, 'http://127.0.0.1:3773/mcp', 'env-mock', Date.now());
  } finally {
    await sql.close();
  }
  // The line says what it waits on; beside 停止, 去批准 opens the run in
  // T3, where the approval is given.
  await expect(waiting).toContainText('Ada 正在等待 T3 中的批准');
  await expect(
    waiting.getByRole('link', { name: /正在等待 T3 中的批准/ }),
  ).toHaveCount(0);
  const approve = waiting.getByRole('link', { name: '去批准 ↗', exact: true });
  await expect(approve).toHaveAttribute('href', thread);
  await expect(approve).toHaveAttribute('target', '_blank');
  await waiting.getByRole('button', { name: '停止', exact: true }).click();
  // The worker interrupts the run; the line says so until it has ended.
  await expect(waiting).toContainText('Ada 正在停止');
  await expect(waiting.getByRole('button', { name: '停止' })).toHaveCount(0);
  expect(
    (await snapshot(context.request, hub.origin)).deliveries.find(
      (d) => d.state === 'waiting',
    ),
  ).toMatchObject({ reason: 'stop-requested', stopRequested: true });
});

test('a week before T3’s sign-in ends anyone reconnects it from the Inbox; once it ends, requests wait and say why', async ({
  page,
  context,
  hub,
}) => {
  // The test says a sign-in is under way by rewriting the workspace it
  // reads, so the view reads it, and nothing arrives on its own.
  await withoutStream(page);
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada) throw new Error('Local fixture unavailable');
  // The team's T3 and the credential its sign-in left, as the hub keeps
  // them. MOCK T3 only: it is never reached.
  const endpoint = 'http://127.0.0.1:3773/mcp';
  const signedIn = (endsIn: number) => {
    saveCredential(t3AuthFile(managedDirectory(hub.state)), {
      endpoint,
      environmentId: 'env-live',
      tokens: {
        access_token: 'browser-local-only',
        token_type: 'Bearer',
        scope: 'orchestration:read orchestration:operate',
      },
      expiresAt: new Date(Date.now() + endsIn).toISOString(),
    });
  };
  const day = 86400_000;
  signedIn(30 * day);
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        'INSERT INTO t3_connections (team_id, endpoint, environment_id, connected_at) VALUES (?, ?, ?, ?)',
      )
      .run(state.team.id, endpoint, 'env-live', Date.now());
  } finally {
    await sql.close();
  }
  const needs = page
    .getByRole('navigation', { name: '收件箱' })
    .getByRole('button', { name: /^收件箱/ });
  const inbox = page.getByRole('region', { name: '收件箱' });
  const sign = inbox.getByRole('listitem').filter({ hasText: /T3 的登录/ });
  // A month to go: nothing to do.
  await refreshNow(page);
  await needs.click();
  await expect(inbox.getByText('都处理完了。')).toBeVisible();
  // Three days to go: everyone of the team is asked, on the Inbox's count too.
  signedIn(3 * day);
  await refreshNow(page);
  await expect(needs).toContainText('1');
  await expect(sign).toContainText(/T3 的登录将于\S+到期/);
  await expect(sign).toContainText('127.0.0.1:3773');
  // One click starts the same sign-in as connecting T3, to the same T3.
  let connecting = false;
  const asked: unknown[] = [];
  await page.route('**/api/teams/*/t3/connect', (route) => {
    asked.push(route.request().postDataJSON());
    connecting = true;
    return route.fulfill({
      json: { authorizationUrl: 'http://127.0.0.1:3773/authorize?state=x' },
    });
  });
  // The mocked T3 starts no sign-in at the hub; the test says it is under way.
  await page.route(
    (url) => url.pathname === '/api/workspace',
    async (route) => {
      const response = await route.fetch();
      const json = WorkspaceSnapshot.parse(await response.json());
      // Another screen, so another revision, as the hub would name it.
      if (connecting && json.attention.t3) {
        json.attention.t3.signIn = 'waiting';
        json.revision = createHash('sha256')
          .update(json.revision + ':waiting')
          .digest('hex');
      }
      await route.fulfill({ response, json });
    },
  );
  await sign.getByRole('button', { name: '重新连接 T3', exact: true }).click();
  await expect(
    sign.getByRole('link', { name: '在 T3 中批准 ↗' }),
  ).toHaveAttribute('href', 'http://127.0.0.1:3773/authorize?state=x');
  await expect(sign).toContainText('监督');
  expect(asked).toEqual([{ endpoint, replace: true }]);
  // The sign-in ends with nobody having reconnected.
  connecting = false;
  signedIn(-1000);
  await refreshNow(page);
  await expect(sign).toContainText('T3 的登录已到期，智能体在等待');
  await expect(sign).toHaveAttribute('data-tone', 'problem');
  await expect(
    sign.getByRole('button', { name: '重新连接 T3', exact: true }),
  ).toBeVisible();
  // A request to Ada waits, and says what it waits for. Ada's worker is
  // running; it found the sign-in ended and sent nothing to T3.
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill('@Ada please check the release notes');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const responses = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'please check the release notes' })
    .first()
    .getByRole('list', { name: '智能体响应' });
  await expect(responses).toContainText('Ada');
  const db = rawDatabase(hub.database);
  try {
    await db
      .prepare(
        'INSERT INTO inbox_bindings (agent_id, team_id, last_seen_at) VALUES (?, ?, ?)',
      )
      .run(ada.id, state.team.id, Date.now() + 10 * 60_000);
    await db
      .prepare(
        "UPDATE agent_inbox SET state = 'ready', reason = 'sign-in-expired'",
      )
      .run();
  } finally {
    await db.close();
  }
  await readAgain(page);
  await expect(
    responses.getByText('T3 重新连接后 Ada 会继续', {
      exact: true,
    }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
