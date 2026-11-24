import { z } from 'zod';
import { rawDatabase } from '../raw.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '../../src/domain/agents.js';
import { test, expect } from './fixture.js';
import {
  agentRow,
  openAgent,
  refreshNow,
  register,
  signIn,
  untilReady,
} from './ui.js';
import { snapshot, runState, openMockNativeCard } from './helpers.js';

// API identity spoofing and cross-team denials are server tests:
// tests/workspace.test.ts and tests/agents.test.ts.
test('AG-UI snapshots render persisted reports honestly', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Observer', 'assistant');
  const state = await snapshot(context.request, hub.origin);
  const agent = Agent.parse(state.agents[0]);
  const base = `${hub.origin}/api/teams/${state.team.id}/agents/${agent.id}`;
  const correlated = await context.request.post(base + '/executions', {
    data: {
      reference: {
        backend: 't3',
        environmentId: 'browser-fixture-environment',
        threadId: 'browser-fixture-thread',
        runId: 'browser-fixture-run',
      },
      providerSessionId: null,
      invocationId: null,
    },
  });
  const correlation = z.object({ id: z.uuid() }).parse(await correlated.json());
  expect(correlated.status()).toBe(201);
  const event = await context.request.post(
    base + '/executions/' + correlation.id + '/events',
    { data: { state: 'waiting' } },
  );
  expect(event.status()).toBe(201);
  await agentRow(page, 'Observer').click();
  await expect(runState(page, '等待中')).toBeVisible();
  await expect(
    page.getByText('browser-fixture-thread', { exact: true }),
  ).toBeVisible();
  // One T3 reference per run: the thread, with the run on hover.
  await expect(page.getByText('browser-fixture-run')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'T3 运行' })).toHaveCount(
    0,
  );
  // No verified link, no link: nothing to click and nothing to explain.
  await expect(
    page.getByRole('link', { name: '在 T3 中打开', exact: true }),
  ).toHaveCount(0);
  // Checking reads the team's T3 connection: before Connect T3 there is
  // nothing to check with, so it isn't offered. (A failing check after
  // connecting is covered by the MOCK tests below and native-http.test.ts.)
  await expect(
    page.getByRole('button', { name: '在 T3 中查看', exact: true }),
  ).toHaveCount(0);
  // A later report replaces the shown state.
  expect(
    (
      await context.request.post(
        base + '/executions/' + correlation.id + '/events',
        { data: { state: 'succeeded' } },
      )
    ).status(),
  ).toBe(201);
  await expect(runState(page, '已完成')).toBeVisible();
});

/**
 * Proves adding an agent never strands it: when joining the channel fails,
 * the agent's page still opens and offers to add it to the channel.
 */
test('an agent whose channel invite fails still opens, with the way into the channel', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  let refuse = true;
  await page.route('**/participants/invite', (route) =>
    refuse ? route.fulfill({ status: 500, json: {} }) : route.continue(),
  );
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  await page
    .getByRole('list', { name: '团队', exact: true })
    .getByRole('button', { name: '添加智能体', exact: true })
    .click();
  const form = page.getByRole('form', { name: '智能体资料' });
  await form.getByLabel('智能体名称').fill('Ada');
  await form.getByLabel('角色', { exact: true }).selectOption('developer');
  await form.getByRole('button', { name: '添加智能体', exact: true }).click();
  const agent = page.getByRole('region', { name: 'Ada', exact: true });
  await expect(agent).toBeVisible();
  await expect(agent).toContainText('Ada 不在这个频道');
  refuse = false;
  await agent.getByRole('button', { name: '把 Ada 加入频道' }).click();
  await expect(
    agent.getByRole('button', { name: '把 Ada 加入频道' }),
  ).toHaveCount(0);
});

/**
 * Proves the T3 step recovers: a failed read says so and is read again by
 * itself, and a sign-in under way is still there to finish after a reload.
 */
test('the T3 step says when it can’t read T3, recovers, and keeps a sign-in under way across a reload', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  // MOCK T3's status only: first unreadable, then a sign-in under way.
  let unreadable = true;
  await page.route('**/api/teams/*/t3', (route) =>
    unreadable
      ? route.fulfill({ status: 500, json: {} })
      : route.fulfill({
          json: {
            connection: null,
            signIn: 'waiting',
            authorizationUrl: 'https://t3.example.com/authorize?state=x',
            pasteCallback: true,
            provisioned: false,
            revision: 'waiting',
          },
        }),
  );
  await page.route('**/api/teams/*/t3/local', (route) =>
    route.fulfill({ json: { endpoint: null } }),
  );
  await agentRow(page, 'Ada').click();
  const agent = page.getByRole('region', { name: 'Ada', exact: true });
  await expect(agent).toContainText('暂时读不到 T3 的状态');
  // Read again by itself once T3 answers, it shows the approval this
  // person started.
  unreadable = false;
  const approve = agent.getByRole('link', { name: '在 T3 中批准 ↗' });
  await expect(approve).toHaveAttribute(
    'href',
    'https://t3.example.com/authorize?state=x',
  );
  // The agent's page is open again by its address.
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Ada', exact: true })
      .getByRole('link', { name: '在 T3 中批准 ↗' }),
  ).toBeVisible();
});

/**
 * Proves an agent's name and role change in place on its page, and that
 * disabling it (a second press) keeps it out of the @ list until enabled.
 */
test('an agent is renamed, given another role, disabled and enabled from its page', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  await openAgent(page, 'Ada');
  const about = page.getByRole('complementary', { name: '关于' });
  const name = about.getByLabel('名称');
  await name.fill('Ada Lovelace');
  await name.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Ada Lovelace', exact: true }),
  ).toBeVisible();
  await about.getByLabel('角色').selectOption('reviewer');
  await expect
    .poll(async () => {
      const state = await snapshot(context.request, hub.origin);
      return state.agents.find((a) => a.name === 'Ada Lovelace')?.role;
    })
    .toBe('reviewer');
  const disable = about.getByRole('button', { name: '停用智能体' });
  await disable.click();
  await about.getByRole('button', { name: /^确认停用：Ada Lovelace/ }).click();
  await expect(
    about.getByRole('button', { name: '重新启用智能体' }),
  ).toBeVisible();
  // Disabled, it isn't offered in the @ list.
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const field = page
    .getByRole('form', { name: '给团队发消息' })
    .getByLabel('消息', { exact: true });
  await field.pressSequentially('@Ada');
  await expect(page.getByRole('listbox', { name: '可提及的成员' })).toHaveCount(
    0,
  );
  await field.fill('');
  await openAgent(page, 'Ada Lovelace');
  await page
    .getByRole('complementary', { name: '关于' })
    .getByRole('button', { name: '重新启用智能体' })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: '关于' })
      .getByRole('button', { name: '停用智能体' }),
  ).toBeVisible();
});

test('a T3 on another computer: the person pastes the address its approval opened', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  // MOCK T3 only, as a team-mode hub sees it: no local T3, approval by paste.
  let t3: 'none' | 'waiting' | 'operate' = 'none';
  const pasted: string[] = [];
  await page.route('**/api/teams/*/t3', (route) =>
    route.fulfill({
      json: {
        connection:
          t3 === 'operate'
            ? {
                endpoint: 'https://t3.example.com/mcp',
                environmentId: 'env-team',
                connectedAt: new Date().toISOString(),
                access: 'operate',
                ceiling: 'approval-required',
                expired: false,
              }
            : null,
        signIn: t3 === 'waiting' ? 'waiting' : null,
        pasteCallback: true,
        provisioned: false,
        revision: t3,
      },
    }),
  );
  await page.route('**/api/teams/*/t3/local', (route) =>
    route.fulfill({ json: { endpoint: null } }),
  );
  await page.route('**/api/teams/*/t3/connect', (route) => {
    t3 = 'waiting';
    return route.fulfill({
      json: { authorizationUrl: 'https://t3.example.com/authorize?state=x' },
    });
  });
  await page.route('**/api/teams/*/t3/callback', (route) => {
    const { url } = z
      .object({ url: z.string() })
      .parse(route.request().postDataJSON());
    pasted.push(url);
    if (!url.includes('state=x'))
      return route.fulfill({ status: 400, json: {} });
    t3 = 'operate';
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/teams/*/t3/providers', (route) =>
    route.fulfill({ json: { providers: [] } }),
  );
  await agentRow(page, 'Ada').click();
  const connectT3 = page
    .getByRole('region', { name: 'Ada', exact: true })
    .getByRole('region', { name: '配置' })
    .getByRole('group', { name: '连接 T3' });
  await connectT3
    .getByLabel('T3 的 MCP URL')
    .fill('https://t3.example.com/mcp');
  await connectT3.getByRole('button', { name: '连接 T3', exact: true }).click();
  // The pairing code comes from the T3 being connected, named by its address.
  await expect(connectT3).toContainText('在 t3.example.com 的 Settings');
  const address = connectT3.getByLabel('批准后的地址');
  await address.fill('http://127.0.0.1:49871/callback?state=y&code=c&iss=z');
  await connectT3.getByRole('button', { name: '完成' }).click();
  await expect(connectT3).toContainText('这不是这次批准打开的地址。');
  const right = 'http://127.0.0.1:49871/callback?state=x&code=c&iss=z';
  await address.fill(right);
  await connectT3.getByRole('button', { name: '完成' }).click();
  // Connected: the next step is choosing what Ada runs on.
  await expect(
    page.getByRole('form', { name: '选择 Ada 使用的模型' }),
  ).toBeVisible();
  expect(pasted.at(-1)).toBe(right);
});

test('connect T3 and an agent in two clicks: the hub keeps the credential and wakes the agent', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada) throw new Error('Local fixture unavailable');
  // MOCK T3 only: discovery, the sign-in and the model list. The rest is real.
  let t3: 'none' | 'waiting' | 'read' | 'operate' = 'none';
  await page.route('**/api/teams/*/t3', (route) =>
    route.fulfill({
      json: {
        connection:
          t3 === 'read' || t3 === 'operate'
            ? {
                endpoint: 'http://127.0.0.1:3773/mcp',
                environmentId: 'env-live',
                connectedAt: new Date().toISOString(),
                access: t3,
                // Approved with Full access once T3 lets Ada run.
                ceiling: t3 === 'operate' ? 'full-access' : null,
                expired: false,
              }
            : null,
        signIn: t3 === 'waiting' ? 'waiting' : null,
        pasteCallback: false,
        provisioned: false,
        revision: t3,
      },
    }),
  );
  await page.route('**/api/teams/*/t3/local', (route) =>
    route.fulfill({ json: { endpoint: 'http://127.0.0.1:3773/mcp' } }),
  );
  await page.route('**/api/teams/*/t3/connect', (route) => {
    t3 = 'waiting';
    return route.fulfill({
      json: { authorizationUrl: 'http://127.0.0.1:3773/authorize?state=x' },
    });
  });
  // T3 is out of reach the first time its models are asked for.
  let reachable = false;
  await page.route('**/api/teams/*/t3/providers', (route) =>
    reachable
      ? route.fulfill({
          json: {
            providers: [
              { id: 'cursor', driver: 'cursor', models: [] },
              { id: 'isolated-ada', driver: 'codex', models: ['model-x'] },
            ],
          },
        })
      : route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await agentRow(page, 'Ada').click();
  const setup = page
    .getByRole('region', { name: 'Ada', exact: true })
    .getByRole('region', { name: '配置' });
  // T3 on this Mac is found: no URL to look up, one button.
  const connectT3 = setup.getByRole('group', { name: '连接 T3' });
  await expect(connectT3).toContainText('T3 正在这台 Mac 上运行');
  await expect(connectT3.getByLabel('T3 的 MCP URL')).toHaveCount(0);
  await connectT3.getByRole('button', { name: '连接 T3', exact: true }).click();
  await expect(
    connectT3.getByRole('link', { name: '在 T3 中批准 ↗' }),
  ).toHaveAttribute('href', 'http://127.0.0.1:3773/authorize?state=x');
  await expect(connectT3).toContainText('配对码');
  await expect(connectT3).toContainText('监督、自动或完全访问');
  // On this Mac the approval comes straight back: nothing to paste.
  await expect(connectT3.getByLabel('批准后的地址')).toHaveCount(0);
  // Approved read-only by mistake: said plainly, before anyone waits.
  // The mocked hub cannot push, so the test reads again in its place.
  t3 = 'read';
  await refreshNow(page);
  const permission = setup.getByRole('group', {
    name: '允许 T3 运行',
  });
  await expect(permission).toContainText('选择运行方式');
  await permission
    .getByRole('button', { name: '连接 T3', exact: true })
    .click();
  // Approved with Full access; the hub records the connection.
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        'INSERT INTO t3_connections (team_id, endpoint, environment_id, connected_at) VALUES (?, ?, ?, ?)',
      )
      .run(state.team.id, 'http://127.0.0.1:3773/mcp', 'env-live', Date.now());
  } finally {
    await sql.close();
  }
  t3 = 'operate';
  const choose = setup.getByRole('form', { name: '选择 Ada 使用的模型' });
  // Out of reach is said as such, not turned into typing model names.
  await expect(choose).toContainText('现在连不上 T3。');
  await expect(choose.getByLabel('模型', { exact: true })).toHaveCount(0);
  await expect(choose.getByRole('button', { name: '连接 Ada' })).toBeDisabled();
  // Once T3 answers, reading again lists its models.
  reachable = true;
  await refreshNow(page);
  // One choice: the model, grouped by provider; providers without models are left out.
  await expect(choose.getByLabel('模型', { exact: true })).toHaveValue(
    'isolated-ada\nmodel-x',
  );
  await expect(choose.locator('optgroup')).toHaveCount(1);
  await choose.getByRole('button', { name: '连接 Ada' }).click();
  // The hub started its own worker for Ada; no file was edited.
  await untilReady(page);
  // What it runs on is said once, in About.
  const about = page.getByRole('complementary', { name: '关于' });
  await expect(about).toContainText('isolated-ada');
  await expect(about).toContainText('model-x');
  // How Ada runs is what the person chose in T3.
  await expect(about).toContainText('127.0.0.1:3773 · 完全访问');
  const tokenFile = join(hub.state, 'managed', 'agents', ada.id + '.json');
  // File mode and saved preferences: tests/connect.test.ts.
  const { token } = z
    .object({ token: z.string() })
    .parse(JSON.parse(readFileSync(tokenFile, 'utf8')));
  expect(await page.content()).not.toContain(token);
  // Ada runs on Codex: its Team MCP credential comes as the lines its Codex
  // adds, which let Kinmesh's tools run without asking anyone.
  await about.getByRole('button', { name: '签发 Team MCP 凭据' }).click();
  const config = about.locator('.token-once pre');
  await expect(config).toContainText('[mcp_servers.kinmesh]');
  await expect(config).toContainText('Authorization = "Bearer ');
  await expect(config).toContainText('default_tools_approval_mode = "approve"');
  await expect(about.getByRole('button', { name: '复制配置' })).toBeVisible();
});

test('the agent panel still walks an operator through a self-run worker binding', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada) throw new Error('Local fixture unavailable');
  await agentRow(page, 'Ada').click();
  // Running the worker by hand opens beside the agent's page.
  await page
    .getByRole('region', { name: 'Ada', exact: true })
    .getByRole('button', { name: '自己运行工作进程 →' })
    .click();
  const setup = page.getByRole('region', {
    name: '自己运行工作进程',
    exact: true,
  });
  const step = (title: string) =>
    setup.getByRole('listitem').filter({ hasText: title });
  await expect(step('运行偏好')).toContainText('（待完成）');
  await setup.getByLabel('T3 环境 ID').fill('env-primary');
  await setup.getByLabel('隔离的提供方 ID').fill('isolated-ada');
  await setup.getByLabel('模型 ID').fill('model-x');
  await setup.getByRole('button', { name: '保存偏好' }).click();
  await expect(step('运行偏好')).toContainText(
    'env-primary · isolated-ada/model-x',
  );
  await expect(step('运行偏好')).toContainText('（已完成）');
  await setup
    .getByRole('button', { name: '签发工作进程凭据', exact: true })
    .click();
  const shown = step('工作进程凭据').locator('.token-once code.reference');
  await expect(shown).toHaveText(/^kma_/);
  const token = await shown.innerText();
  await expect(step('工作进程凭据')).toContainText('（已完成）');
  // The credential is shown once: neither the API nor the page can repeat it.
  await setup.getByRole('button', { name: '我已保存' }).click();
  await expect(shown).toHaveCount(0);
  const grantsUrl = `${hub.origin}/api/teams/${state.team.id}/agents/${ada.id}/grants`;
  const listed = await (await context.request.get(grantsUrl)).text();
  expect(listed).not.toContain(token);
  expect(listed).not.toContain('"token"');
  expect(await page.content()).not.toContain(token);
  const credentials = setup.getByRole('list', { name: '凭据' });
  await credentials.getByRole('button', { name: '轮换' }).click();
  await expect(shown).toHaveText(/^kma_/);
  await expect(shown).not.toHaveText(token);
  await setup.getByRole('button', { name: '我已保存' }).click();
  await expect(credentials).toContainText('已吊销');
  await credentials.getByRole('button', { name: '吊销' }).click();
  await expect(step('工作进程凭据')).toContainText('（待完成）');
  await expect(
    setup.getByRole('button', { name: '签发工作进程凭据' }),
  ).toBeVisible();
  // The binding is generated for this agent and carries no secret.
  const snippet = step('收件箱工作进程绑定').locator('pre');
  await expect(snippet).toContainText(ada.id);
  await expect(snippet).toContainText('"isolatedProviderId": "isolated-ada"');
  await expect(snippet).not.toContainText('kma_');
});

test('AG-UI access revocation clears prior reports while a transient outage preserves a labeled stale snapshot', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Revoked Activity', 'assistant');
  const state = await snapshot(context.request, hub.origin);
  const agent = state.agents.find((a) => a.name === 'Revoked Activity');
  if (!agent) throw new Error('Test agent missing');
  const thread = 'former-authorized-execution-thread';
  const base = `${hub.origin}/api/teams/${state.team.id}/agents/${agent.id}`;
  const created = await context.request.post(base + '/executions', {
    data: {
      reference: {
        backend: 't3',
        environmentId: 'fixture-environment',
        threadId: thread,
        runId: 'fixture-run',
      },
      providerSessionId: null,
      invocationId: null,
    },
  });
  expect(created.status()).toBe(201);
  await agentRow(page, 'Revoked Activity').click();
  await expect(page.getByText(thread, { exact: true })).toBeVisible();

  await page.route('**/api/agui/**', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{}',
    });
  });
  await refreshNow(page);
  await expect(
    page.getByText('现在无法加载活动，下次刷新时会再试。'),
  ).toBeVisible();
  await expect(page.getByText(thread, { exact: true })).toBeVisible();

  await page.unroute('**/api/agui/**');
  let denied = 0;
  await page.route('**/api/agui/**', async (route) => {
    denied++;
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{}',
    });
  });
  await refreshNow(page);
  await expect(
    page.getByText('你已无权查看这些活动。请重新登录。'),
  ).toBeVisible();
  await expect(page.getByText(thread, { exact: true })).toHaveCount(0);
  await expect(runState(page, '未知')).toHaveCount(0);
  expect(denied).toBeGreaterThan(0);
  expect(
    (
      await context.request.get(
        `${hub.origin}/api/agui/${state.team.id}/${agent.id}`,
      )
    ).status(),
  ).toBe(200);
});

test('MOCK UI only: strict native observation renders separate exact state/link and clears on 503 or invalid DTO', async ({
  page,
  context,
  hub,
}) => {
  const observation = await openMockNativeCard(page, context.request, hub);
  // The agent's page, on a phone.
  await page.setViewportSize({ width: 375, height: 1000 });
  let body: unknown = observation;
  let status = 200;
  await page.route('**/executions/*/native', async (route) => {
    expect(route.request().method()).toBe('GET');
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  const check = page.getByRole('button', { name: '在 T3 中查看' });
  await check.click();
  await expect(page.getByText(/T3 确认/)).toBeVisible();
  await expect(page.getByText('这次运行：interrupted · 已结束')).toBeVisible();
  await expect(page.getByText(/这个对话中未处理的请求：2/)).toBeVisible();
  await expect(runState(page, '未知')).toBeVisible();
  const link = page.getByRole('link', { name: '在 T3 中打开', exact: true });
  await expect(link).toHaveAttribute('href', observation.verifiedUrl);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  status = 503;
  await check.click();
  await expect(page.getByText(/现在无法查看 T3/)).toBeVisible();
  await expect(link).toHaveCount(0);
  await expect(page.getByText(/T3 确认/)).toHaveCount(0);
  // One invalid DTO proves the page clears on a rejected decode; every
  // rejected shape is in tests/native.test.ts.
  status = 200;
  await check.click();
  await expect(link).toBeVisible();
  body = { ...observation, verifiedUrl: 'javascript:alert(1)' };
  await check.click();
  await expect(page.getByText(/现在无法查看 T3/)).toBeVisible();
  await expect(link).toHaveCount(0);
  await expect(page.getByText(/T3 确认/)).toHaveCount(0);
  expect((await context.request.get(hub.origin + '/api/me')).status()).toBe(
    200,
  );
});

test('MOCK UI only: native HTTP 401 or 403 purges native result and protected AG-UI card', async ({
  page,
  context,
  hub,
}) => {
  const observation = await openMockNativeCard(page, context.request, hub);
  let status = 200;
  await page.route('**/executions/*/native', async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(status === 200 ? observation : {}),
    });
  });
  for (const denied of [401, 403]) {
    if (denied !== 401) {
      // The card was purged; a reload brings it back.
      await page.reload();
      await openAgent(page, 'Mock Native Observer');
      await expect(
        page.getByText('MOCK-thread', { exact: true }),
      ).toBeVisible();
    }
    status = 200;
    await page.getByRole('button', { name: '在 T3 中查看' }).click();
    await expect(
      page.getByRole('link', { name: '在 T3 中打开', exact: true }),
    ).toBeVisible();
    status = denied;
    await page.getByRole('button', { name: '在 T3 中查看' }).click();
    await expect(
      page.getByText('你已无权查看这些活动。请重新登录。'),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: '在 T3 中打开', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/T3 确认/)).toHaveCount(0);
    await expect(page.getByText('MOCK-thread', { exact: true })).toHaveCount(0);
    await expect(runState(page, '未知')).toHaveCount(0);
    expect((await context.request.get(hub.origin + '/api/me')).status()).toBe(
      200,
    );
  }
});
