import type { Page, APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { rawDatabase } from '../raw.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, Grant } from '../../src/domain/agents.js';
import { Task, TaskResult } from '../../src/domain/tasks.js';
import { pageOf } from '../../src/domain/communication.js';
import { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { saveCredential } from '../../src/adapters/t3/oauth.js';
import { managedDirectory, t3AuthFile } from '../../src/inbox/managed.js';
import { test, expect } from './fixture.js';
import {
  agentRow,
  backToBoard,
  createChannel,
  inStage,
  newTask,
  openAgent,
  refreshNow,
  register,
  signIn,
  taskPage,
  untilReady,
} from './ui.js';
/**
 * Records what the page hands the clipboard: CI's headless browser has no
 * system clipboard to read back, and what a button copies is the point.
 */
async function recordCopies(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.defineProperty(window, '__copied', { value: copied });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  return async () =>
    z
      .array(z.string())
      .parse(
        await page.evaluate((): unknown => Reflect.get(window, '__copied')),
      )
      .at(-1);
}
async function snapshot(request: APIRequestContext, origin: string) {
  const response = await request.get(origin + '/api/workspace');
  expect(response.status()).toBe(200);
  return WorkspaceSnapshot.parse(await response.json());
}
/**
 * Holds every event stream unopened, so what the view shows comes only from
 * reading the workspace, which the test holds or rewrites. Silent streams
 * leave the view to read the workspace itself.
 */
async function withoutStream(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/events',
    () => undefined,
  );
}
/** The one line that says what is on screen is stale. */
function staleLine(page: Page) {
  return page.getByRole('status').filter({ hasText: '连不上 Kinmesh' });
}
/** Healthy is silent: no refresh pill and no stale line. */
async function expectHealthy(page: Page) {
  await expect(
    page.getByRole('status').filter({ hasText: /^正在刷新…$/ }),
  ).toHaveCount(0);
  await expect(staleLine(page)).toHaveCount(0);
}
/** WCAG contrast of an element's text against the surface it sits on. */
function contrast(page: Page, selector: string) {
  return page.evaluate((target) => {
    const rgba = (color: string) => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('No canvas');
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (color: number[]) => {
      const [r = 0, g = 0, b = 0] = color.slice(0, 3).map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const element = document.querySelector(target);
    if (!element) throw new Error('Nothing matches ' + target);
    // The nearest ancestor that paints an opaque background.
    let surface: number[] | null = null;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const painted = rgba(getComputedStyle(node).backgroundColor);
      if (painted[3] === 255) {
        surface = painted;
        break;
      }
    }
    if (!surface) throw new Error('No surface under ' + target);
    const ink = luminance(rgba(getComputedStyle(element).color));
    const paper = luminance(surface);
    return (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05);
  }, selector);
}
/** A run's state as its row says it. */
function runState(page: Page, label: string) {
  return page.locator('.run-state').getByText(label, { exact: true });
}
async function agentGrant(
  request: APIRequestContext,
  origin: string,
  teamId: string,
  agentId: string,
) {
  const response = await request.post(
    `${origin}/api/teams/${teamId}/agents/${agentId}/grants`,
    {
      data: {
        label: 'browser-local-only',
        scopes: [
          'channels:read',
          'channels:write',
          'tasks:read',
          'tasks:write',
          'tasks:review',
        ],
        lifetimeSeconds: 600,
      },
    },
  );
  expect(response.status()).toBe(201);
  return z
    .strictObject({ grant: Grant, token: z.string() })
    .parse(await response.json()).token;
}
test('a desktop workspace loads without sideways scrolling', async ({
  page,
  hub,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, hub);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
/**
 * Proves what someone else writes while you are in the conversation is read
 * out to a screen reader: who, then what, in a polite live region.
 */
test('a message from someone else is announced politely as it arrives', async ({
  page,
  browser,
  hub,
}) => {
  await signIn(page, hub, 'ada@example.com');
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    const composer = grace.getByRole('form', { name: '给团队发消息' });
    await composer.getByLabel('消息', { exact: true }).fill('Hi **Ada**');
    await composer.getByRole('button', { name: '发送消息' }).click();
    const said = page.locator('[aria-live="polite"].visually-hidden');
    await expect(said).toHaveText('Grace Hopper：Hi Ada');
  } finally {
    await theirs.close();
  }
});
test('a second person of the organization signs in to the same workspace and sees who is there', async ({
  page,
  browser,
  hub,
}) => {
  await signIn(page, hub, 'ada@example.com');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('Hello, team');
  await composer.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('Hello, team', { exact: true })).toBeVisible();
  // Someone else, in their own browser.
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    await expect(grace.getByText('Hello, team', { exact: true })).toBeVisible();
    // The message is Ada's by name, and Ada is among the people here.
    await expect(
      grace
        .getByRole('list', { name: '频道消息' })
        .getByRole('listitem')
        .filter({ hasText: 'Hello, team' }),
    ).toContainText('ada');
    const people = grace.getByRole('region', {
      name: '本频道成员',
    });
    await expect(people.getByText('ada', { exact: true })).toBeVisible();
    // And Ada sees Grace arrive, online, without reloading: by the name and
    // picture Feishu gives her, served from here, never by her handle.
    const here = page.getByRole('region', { name: '本频道成员' });
    const graceRow = here
      .locator('.person')
      .filter({ hasText: 'Grace Hopper' });
    await expect(graceRow).toBeVisible();
    await expect(here.getByText('grace', { exact: true })).toHaveCount(0);
    await expect(graceRow.locator('.avatar img')).toHaveAttribute(
      'src',
      /^\/api\/teams\/[^/]+\/people\/[^/]+\/avatar\?v=/,
    );
    // The picture itself loads: the browser decoded it.
    await expect
      .poll(() =>
        graceRow
          .locator('.avatar img')
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1);
    // A person is added to a channel the way an agent is: from their tile.
    await createChannel(page, 'design');
    await expect(graceRow).toHaveCount(0);
    await page.getByRole('tab', { name: '成员', exact: true }).click();
    const add = page.getByRole('button', {
      name: '把 Grace Hopper 加入 #design',
    });
    await add.click();
    await expect(graceRow).toBeVisible();
    await expect(add).toHaveCount(0);
    // The @ popover finds her by a word of her name, and the message says
    // her name once, with no second chip.
    await page.getByRole('tab', { name: '聊天', exact: true }).click();
    const message = composer.getByLabel('消息', { exact: true });
    await message.pressSequentially('Thanks @Hop');
    await page
      .getByRole('listbox', { name: '可提及的成员' })
      .getByRole('option', { name: /Grace Hopper/ })
      .click();
    await expect(message).toHaveValue('Thanks @Grace Hopper ');
    await composer.getByRole('button', { name: '发送消息' }).click();
    const posted = page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: 'Thanks @Grace Hopper' });
    await expect(posted).toBeVisible();
    await expect(posted.getByRole('list', { name: '已提及' })).toHaveCount(0);
    // Grace finds the channel in her sidebar without reloading.
    await expect(
      grace
        .getByRole('navigation', { name: '频道' })
        .getByRole('button', { name: 'design', exact: true }),
    ).toBeVisible();
  } finally {
    await theirs.close();
  }
});
test('real workspace onboarding, mentions and reconnect on a phone', async ({
  page,
  context,
  hub,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, hub);
  await createChannel(page, 'design');
  await register(page, 'Ada', 'developer');
  // A phone stacks the places. The team is a view of the channel, beside
  // its chat and board, as on a wider screen.
  await page.setViewportSize({ width: 375, height: 1000 });
  await expect(
    page.getByRole('tab', { name: '成员', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(agentRow(page, 'Ada')).toBeVisible();
  // Back leads Home: the channels as conversations, and no gallery.
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const places = page.getByRole('navigation', { name: '位置' });
  await expect(places.getByRole('button', { name: '频道' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('list', { name: '团队', exact: true }),
  ).toHaveCount(0);
  // Search is a tab of its own: the field waits at the bottom, just above
  // the tabs, ready to type in, and Esc goes back.
  await places.getByRole('button', { name: '搜索', exact: true }).click();
  const search = page.getByRole('combobox', { name: /搜索/ });
  await expect(search).toBeFocused();
  const [field, tabs] = await Promise.all([
    search.boundingBox(),
    places.boundingBox(),
  ]);
  expect(field && tabs && field.y + field.height <= tabs.y).toBe(true);
  expect(field && tabs && tabs.y - (field.y + field.height) < 24).toBe(true);
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  // A choice goes there and leaves search.
  await places.getByRole('button', { name: '搜索', exact: true }).click();
  await search.fill('design');
  await page
    .getByRole('listbox', { name: '结果' })
    .getByRole('option', { name: /^# design/ })
    .click();
  await expect(search).toBeHidden();
  // A channel has the screen, under a bar that says where it is.
  await expect(
    page.getByRole('heading', { name: '# design', exact: true }),
  ).toBeVisible();
  await expect(places).toBeHidden();
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await page.getByRole('button', { name: '新建话题' }).click();
  await page.getByLabel('话题名称').fill('Release planning');
  await page.getByLabel('话题名称').press('Enter');
  // The topic just made is the one you are in.
  const topics = page.getByRole('group', { name: '话题' });
  await expect(
    topics.getByRole('button', { name: 'Release planning', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const text = '<img src=x onerror="window.__injected=true"> Persistent hello';
  const sent = text + ' @Ada';
  const message = composer.getByLabel('消息', { exact: true });
  await message.fill(text);
  await message.pressSequentially(' @Ad');
  await page
    .getByRole('listbox', { name: '可提及的成员' })
    .getByRole('option', { name: /Ada/ })
    .click();
  await expect(
    composer.getByRole('list', { name: '提及' }).getByText('@Ada'),
  ).toBeVisible();
  await composer.getByRole('button', { name: '发送消息' }).click();
  await expect(
    page
      .getByRole('list', { name: '频道消息' })
      .getByText(sent, { exact: true }),
  ).toBeVisible();
  // The mention reads in the text itself; no second @Ada chip repeats it,
  // and it still reaches Ada (its delivery line is shown).
  const posted = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: sent });
  await expect(posted.getByRole('list', { name: '已提及' })).toHaveCount(0);
  await expect(posted.getByRole('list', { name: '智能体响应' })).toContainText(
    'Ada',
  );
  await page.reload();
  await expect(page.getByText(sent, { exact: true })).toBeVisible();
  expect(await page.locator('.messages img').count()).toBe(0);
  // Healthy is silent. Out of reach is one line with nothing to press, and
  // nothing in it speaks HTTP.
  await expectHealthy(page);
  await context.setOffline(true);
  await refreshNow(page);
  await expect(staleLine(page)).toBeVisible();
  await expect(
    page.getByRole('button', { name: /重新连接|再试一次|重试/ }),
  ).toHaveCount(0);
  // Asking again while still out of reach keeps the honest state.
  await refreshNow(page);
  await expect(staleLine(page)).toBeVisible();
  // Coming back online reconnects by itself.
  await context.setOffline(false);
  await expectHealthy(page);
  await expect(page.getByText(sent, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const ids = await page
    .locator('[id]')
    .evaluateAll((elements) => elements.map((e) => e.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(errors).toEqual([]);
  // Back leads Home; 我 opens the settings map, where signing out is in
  // 账户与设备.
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(places).toBeVisible();
  await places.getByRole('button', { name: '我' }).click();
  await page.getByRole('button', { name: '账户与设备', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('link', { name: '使用飞书登录' })).toBeVisible();
});
test('two independent task cards: real agent handoff, human review, acceptance and rework', async ({
  page,
  context,
  playwright,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Developer', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const developer = state.agents[0];
  if (!developer || !state.channel)
    throw new Error('Local fixture unavailable');
  const token = await agentGrant(
    context.request,
    hub.origin,
    state.team.id,
    developer.id,
  );
  // An independent authenticated local Agent HTTP client, not a model or native T3 call.
  const agent = await playwright.request.newContext({
    extraHTTPHeaders: { authorization: 'Bearer ' + token },
  });
  try {
    for (const title of ['Ship alpha', 'Ship beta']) {
      await newTask(page, {
        title,
        description: 'Browser responsibility test',
        criteria: ['Reviewed and human accepted'],
        owner: 'agent:' + developer.id,
        reviewer: 'human:' + state.human.id,
      });
      await backToBoard(page);
      await expect(
        page.getByRole('article', { name: title, exact: true }),
      ).toBeVisible();
    }
    const base = `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/tasks`;
    const tasksResponse = await context.request.get(base);
    const tasks = pageOf(Task).parse(await tasksResponse.json()).items;
    expect(tasks).toHaveLength(2);
    const ids = await page
      .locator('[id]')
      .evaluateAll((elements) => elements.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of tasks) {
      const handoff = await agent.post(
        base + '/' + task.id + '/request-review',
        {
          data: {
            operationKey: randomUUID(),
            expectedVersion: task.version,
            note: 'Ready for human technical review',
            reviewer: { kind: 'human', id: state.human.id },
          },
        },
      );
      expect(handoff.status()).toBe(200);
      expect(TaskResult.parse(await handoff.json()).task.state.status).toBe(
        'review-requested',
      );
    }
    const alpha = page.getByRole('article', {
      name: 'Ship alpha',
      exact: true,
    });
    const beta = page.getByRole('article', { name: 'Ship beta', exact: true });
    // Each task opens as its own page in place of the board; decisions are
    // explicit buttons, and Esc returns to the board.
    const alphaPage = taskPage(page, 'Ship alpha');
    const betaPage = taskPage(page, 'Ship beta');
    await expect(inStage(page, '审核中', 'Ship alpha')).toBeVisible();
    await alpha.getByRole('button', { name: 'Ship alpha' }).click();
    await expect(page.getByRole('region', { name: '任务看板' })).toBeHidden();
    await alphaPage.getByLabel('决定备注').fill('Technical review complete');
    await alphaPage
      .getByRole('button', { name: '审核通过', exact: true })
      .click();
    await expect(
      alphaPage.getByRole('button', { name: '验收通过', exact: true }),
    ).toBeVisible();
    await backToBoard(page);
    await expect(inStage(page, '待验收', 'Ship alpha')).toBeVisible();
    await expect(inStage(page, '审核中', 'Ship beta')).toBeVisible();
    await alpha.getByRole('button', { name: 'Ship alpha' }).click();
    await alphaPage.getByLabel('决定备注').fill('I accept the alpha outcome');
    await alphaPage
      .getByRole('button', { name: '验收通过', exact: true })
      .click();
    await expect(alphaPage.getByText('任务已关闭。')).toBeVisible();
    await backToBoard(page);
    await expect(inStage(page, '已完成', 'Ship alpha')).toBeVisible();
    await beta.getByRole('button', { name: 'Ship beta' }).click();
    await expect(alphaPage).toHaveCount(0);
    // Sending back is in the quiet row after the review decision; chosen,
    // it is a form of its own with its own note.
    await betaPage
      .getByRole('button', { name: '退回修改', exact: true })
      .click();
    const sendBack = betaPage.getByRole('form', { name: '退回修改' });
    await sendBack.getByLabel('决定备注').fill('Beta needs more work');
    await sendBack
      .getByRole('button', { name: '退回修改', exact: true })
      .click();
    // Sent back, the task's progress returns to Working. The acceptor can
    // still ask for rework, so the button rightly stays.
    await expect(
      betaPage
        .getByRole('list', { name: '任务进度' })
        .locator('[aria-current="step"]'),
    ).toHaveText('进行中');
    await backToBoard(page);
    // Sent back is still Working, and the card says so in words.
    await expect(inStage(page, '进行中', 'Ship beta')).toBeVisible();
    await expect(beta.getByText('已退回', { exact: true })).toBeVisible();
    await expect(inStage(page, '已完成', 'Ship alpha')).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: '看板', exact: true }).click();
    await expect(inStage(page, '已完成', 'Ship alpha')).toBeVisible();
    await expect(inStage(page, '进行中', 'Ship beta')).toBeVisible();
  } finally {
    await agent.dispose();
  }
});
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

test('keyboard mention, and a message becomes a task in its topic', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await page.getByRole('button', { name: '新建话题' }).click();
  await page.getByLabel('话题名称').fill('Billing');
  await page.getByLabel('话题名称').press('Enter');
  // The topic just made opens, with the composer ready to type in.
  await expect(
    page
      .getByRole('list', { name: '话题' })
      .getByRole('button', { name: 'Billing', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const message = composer.getByLabel('消息', { exact: true });
  await expect(message).toBeFocused();
  // No wait for the topic refresh: typing must survive a background reload.
  await message.fill('Validate postal codes per country');
  await message.pressSequentially(' @a');
  await expect(message).toHaveValue('Validate postal codes per country @a');
  await expect(
    page.getByRole('option', { name: /Ada/, selected: true }),
  ).toBeVisible();
  await message.press('Enter');
  await expect(message).toHaveValue('Validate postal codes per country @Ada ');
  await expect(
    composer.getByRole('list', { name: '提及' }).getByText('@Ada'),
  ).toBeVisible();
  // Sent while the topic switch may still be refreshing: it must go through.
  await message.press('ControlOrMeta+Enter');
  const posted = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Validate postal codes per country @Ada' });
  await expect(posted).toBeVisible();
  // Sending keeps the keyboard: the next message can be typed at once.
  await expect(message).toBeFocused();
  await expect(message).toHaveValue('');
  await posted.getByRole('button', { name: '转为任务', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: '看板', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const form = page.getByRole('form', { name: '新任务' });
  await expect(form.getByLabel('任务标题')).toHaveValue(
    'Validate postal codes per country @Ada',
  );
  await expect(
    page.getByText('来自 browser_owner 的消息', { exact: true }),
  ).toBeVisible();
  await form.getByLabel('完成标准').fill('Postal codes validated per country');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada || !state.channel) throw new Error('Local fixture unavailable');
  await form
    .getByLabel('负责人', { exact: true })
    .selectOption('agent:' + ada.id);
  await form.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(
    taskPage(page, 'Validate postal codes per country @Ada'),
  ).toBeVisible();
  await backToBoard(page);
  const card = page.getByRole('article', {
    name: 'Validate postal codes per country @Ada',
  });
  await expect(
    inStage(page, '进行中', 'Validate postal codes per country @Ada'),
  ).toBeVisible();
  const base = `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}`;
  const tasks = pageOf(Task).parse(
    await (await context.request.get(base + '/tasks')).json(),
  ).items;
  const topics = z
    .object({ items: z.array(z.object({ id: z.uuid(), title: z.string() })) })
    .parse(await (await context.request.get(base + '/topics')).json()).items;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.topicId).toBe(topics.find((t) => t.title === 'Billing')?.id);
  // Search, from the magnifier by the team name, jumps straight to the task; only its acceptor may cancel it, with a note.
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const search = page.getByRole('combobox', { name: /搜索/ });
  await search.fill('postal 进行中');
  await expect(
    page
      .getByRole('listbox', { name: '结果' })
      .getByRole('option', { name: /Validate postal codes/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(search).toBeHidden();
  const task = taskPage(page, 'Validate postal codes per country @Ada');
  await expect(task).toBeVisible();
  // Cancelling is the last of the quiet row; chosen, its note opens in place.
  await task.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(task.getByText(/不经验收直接关闭任务/)).toBeVisible();
  await task.getByLabel('决定备注').fill('Superseded by the new form');
  await task.getByRole('button', { name: '取消任务', exact: true }).click();
  // Cancelled work leaves the board quietly; it is one click away in Done.
  await expect(task.getByText('任务已关闭。')).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '显示已取消', exact: true }).click();
  await expect(
    inStage(page, '已完成', 'Validate postal codes per country @Ada').getByText(
      '已取消',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: '任务已取消。' }),
  ).toBeVisible();
});

test('a mention says what happened to it and leads to the agent’s reply, said once', async ({
  page,
  context,
  playwright,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada || !state.channel) throw new Error('Local fixture unavailable');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const item = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text })
      .first();
  // Said once the hub has it: it is in the workspace, no longer on its way.
  const say = async (text: string) => {
    await composer.getByLabel('消息', { exact: true }).fill(text);
    await composer.getByRole('button', { name: '发送消息' }).click();
    await expect(item(text)).toBeVisible();
    await expect(item(text)).not.toHaveAttribute('data-pending');
  };
  await say('@Ada please check the release notes');
  const asked = item('please check the release notes');
  const responses = asked.getByRole('list', { name: '智能体响应' });
  // Each delivery state's sentence: tests/delivery-copy.test.ts.
  await expect(responses).toContainText('Ada 离线');
  const token = await agentGrant(
    context.request,
    hub.origin,
    state.team.id,
    ada.id,
  );
  const agent = await playwright.request.newContext({
    extraHTTPHeaders: { authorization: 'Bearer ' + token },
  });
  /** What the worker does on success: Ada replies, and the delivery is acknowledged with that reply. */
  const answer = async (question: string, body: string) => {
    const source = (
      await snapshot(context.request, hub.origin)
    ).messages.items.find((m) => m.body.includes(question));
    if (!source || !state.channel) throw new Error('Mention not persisted');
    const posted = await agent.post(
      `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/messages`,
      {
        data: {
          operationKey: randomUUID(),
          body,
          topicId: null,
          mentions: [],
          sourceMessageId: source.id,
          sourceEventId: null,
        },
      },
    );
    expect(posted.status()).toBe(201);
    const reply = z.object({ id: z.uuid() }).parse(await posted.json());
    const db = rawDatabase(hub.database);
    try {
      await db
        .prepare(
          "UPDATE agent_inbox SET state = 'acked', reason = 'assistant-result-published', result_message_id = ? WHERE message_id = ?",
        )
        .run(reply.id, source.id);
    } finally {
      await db.close();
    }
  };
  try {
    // Something else is said before Ada answers: the line leads to her
    // reply, and the reply quotes what it answers.
    await say('Meanwhile, the docs build is green');
    await answer(
      'please check the release notes',
      'Release notes checked; two links were broken and are fixed.',
    );
    await responses.getByRole('button', { name: /Ada 已回复/ }).click();
    const reply = item('two links were broken');
    await expect(reply).toBeInViewport();
    await expect(
      reply.getByRole('button', { name: /回复 browser_owner/ }),
    ).toBeVisible();
    // Answered right under the question, neither is said: the reply's place
    // says it.
    await say('@Ada and the changelog?');
    await answer('and the changelog?', 'The changelog lists both fixes.');
    const next = item('The changelog lists both fixes.');
    await expect(next).toBeVisible();
    await expect(
      item('and the changelog?').getByRole('list', { name: '智能体响应' }),
    ).toHaveCount(0);
    await expect(next.getByRole('button', { name: /^回复 / })).toHaveCount(0);
  } finally {
    await agent.dispose();
  }
});

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
  // The sentence itself goes to T3, where the approval is given.
  const approve = waiting.getByRole('link', {
    name: 'Ada 正在等待 T3 中的批准 ↗',
    exact: true,
  });
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

/**
 * Proves an input method keeps its keys: the Enter that commits a pinyin
 * candidate never chooses from the @ list; a plain Enter then does.
 */
test('Enter committing an input method candidate never picks from the @ list', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  await field.pressSequentially('@Ad');
  const list = page.getByRole('listbox', { name: '可提及的成员' });
  await expect(list).toBeVisible();
  for (const init of [
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 },
  ])
    await field.dispatchEvent('keydown', { ...init, bubbles: true });
  await expect(field).toHaveValue('@Ad');
  await expect(composer.getByRole('list', { name: '提及' })).toHaveCount(0);
  await expect(list).toBeVisible();
  await field.press('Enter');
  await expect(composer.getByRole('list', { name: '提及' })).toContainText(
    '@Ada',
  );
});

/**
 * Proves removing a mention takes it back: the chip and the `@Name` written
 * for it go, and the message reaches no agent.
 */
test('removing a mention chip takes the mention out of the message', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  await field.pressSequentially('@Ad');
  await page
    .getByRole('listbox', { name: '可提及的成员' })
    .getByRole('option', { name: /Ada/ })
    .click();
  await field.pressSequentially('only a note');
  await composer.getByRole('button', { name: '移除对 Ada 的提及' }).click();
  await expect(field).toHaveValue('only a note');
  await expect(composer.getByRole('list', { name: '提及' })).toHaveCount(0);
  await composer.getByRole('button', { name: '发送消息' }).click();
  const sent = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'only a note' });
  await expect(sent).toBeVisible();
  await expect(sent.getByRole('list', { name: '智能体响应' })).toHaveCount(0);
});

/**
 * Proves an `@` reaches only the agent it names, even when another's name
 * starts it: the one chosen from the list, or the whole name typed. And that
 * the step a run is on stays inside its message, cut to one line, however
 * long.
 */
test('@ reaches only the agent chosen or named in full, and a long step stays inside its message', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Pi', 'developer');
  await register(page, 'Pi 2', 'developer');
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  const responsesTo = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text })
      .first()
      .getByRole('list', { name: '智能体响应' });
  // Chosen from the list: `@Pi` offers both, and Pi 2 is the one chosen.
  await field.pressSequentially('@Pi');
  await page
    .getByRole('listbox', { name: '可提及的成员' })
    .getByRole('option', { name: /Pi 2/ })
    .click();
  await field.pressSequentially('report on the MCP design');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const responses = responsesTo('report on the MCP design');
  await expect(responses.getByRole('listitem')).toHaveCount(1);
  await expect(responses).toContainText('Pi 2 离线');
  // Typed in full, without the list.
  await field.fill('@Pi 2 draw its architecture');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const typed = responsesTo('draw its architecture');
  await expect(typed.getByRole('listitem')).toHaveCount(1);
  await expect(typed).toContainText('Pi 2 离线');
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'report on the MCP design' })
    .first();
  // Its run is under way in T3, on a step far longer than the message.
  const step = `/bin/bash -lc "cd ppap && cat AGENTS.md | rg -n 'MCP|design|architecture' ${'docs/ '.repeat(30)}"`;
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        "UPDATE agent_inbox SET state = 'waiting', reason = 'execution-active', step = ?, reference = ? WHERE state = 'ready'",
      )
      .run(
        step,
        JSON.stringify({
          backend: 't3',
          environmentId: 'env-mock',
          threadId: 'thread-mock',
          runId: 'run-mock',
        }),
      );
  } finally {
    await sql.close();
  }
  const shown = responses.locator('.delivery-step');
  await expect(shown).toContainText('cd ppap');
  const [row, lines] = await Promise.all([
    message.boundingBox(),
    responses.boundingBox(),
  ]);
  expect(row && lines && lines.x + lines.width <= row.x + row.width).toBe(true);
  // Cut, not wrapped, and the page never scrolls sideways.
  expect(await shown.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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
              { id: 'cursor', models: [] },
              { id: 'isolated-ada', models: ['model-x'] },
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

/**
 * Proves every notice in one update is shown, one after another, each a
 * button that opens what it is about, inside the page's one live region.
 */
test('two notices arriving together are both shown, one after the other', async ({
  page,
  hub,
}) => {
  await withoutStream(page);
  await signIn(page, hub);
  // MOCK only the notices; the rest of the workspace is the hub's.
  await page.route('**/api/workspace?*', async (route) => {
    const response = await route.fetch();
    const body = z.record(z.string(), z.unknown()).parse(await response.json());
    await route.fulfill({
      response,
      json: {
        ...body,
        // A snapshot that says something new comes with a new revision.
        revision: 'f'.repeat(64),
        notices: [
          { id: 'n1', title: 'Ada 提到了你', body: 'first', url: '/' },
          { id: 'n2', title: 'Pi 回复了你', body: 'second', url: '/' },
        ],
      },
    });
  });
  await refreshNow(page);
  const first = page.getByRole('button', { name: /Ada 提到了你/ });
  await expect(first).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Ada 提到了你');
  await first.click();
  await expect(page.getByRole('button', { name: /Pi 回复了你/ })).toBeVisible();
});

/**
 * Proves an action that doesn't happen says so: a refused pause, and signing
 * out while Kinmesh can't be reached.
 */
test('a menu action the hub refuses, and one that can’t go while out of reach, each say so', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await page.route('**/api/me/pause', (route) =>
    route.fulfill({ status: 500, json: {} }),
  );
  await page.getByRole('button', { name: '你的账户' }).click();
  await page.getByRole('menuitem', { name: '暂停 1 小时' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '没能改好，请再试一次。' }),
  ).toBeVisible();
  // Out of reach, signing out says why it waits instead of doing nothing.
  await context.setOffline(true);
  await refreshNow(page);
  await expect(staleLine(page)).toBeVisible();
  await page.getByRole('button', { name: '你的账户' }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '连不上 Kinmesh，恢复连接后再试。' }),
  ).toBeVisible();
  await context.setOffline(false);
});

/**
 * Proves a workspace this page can't read (as after an update it predates)
 * reloads the page once, and failing again shows the way back, not a blank
 * page or a claim that Kinmesh is unreachable.
 */
test('a workspace the page cannot read reloads it once, then offers the way back', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.route(
    (url) => url.pathname === '/api/events',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: workspace\ndata: {"not":"a workspace"}\n\n',
      }),
  );
  let loads = 0;
  page.on('load', () => {
    loads++;
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '页面出了问题' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible();
  await expect(staleLine(page)).toHaveCount(0);
  // One reload by itself, then it waits for the person.
  expect(loads).toBe(2);
});

/**
 * Proves a read the network holds open still ends: after its timeout the
 * page says it can't reach Kinmesh, and once the hub answers again it
 * recovers by itself.
 */
test('a workspace read the network never answers ends, says so, and recovers', async ({
  page,
  hub,
}) => {
  test.setTimeout(60_000);
  await withoutStream(page);
  await signIn(page, hub);
  await expectHealthy(page);
  let hold = true;
  await page.route('**/api/workspace?*', async (route) => {
    if (hold) return; // Never answered while held.
    await route.continue();
  });
  await refreshNow(page);
  await expect(staleLine(page)).toBeVisible({ timeout: 15_000 });
  // The page asks again every 5 seconds while out of reach.
  hold = false;
  await expect(staleLine(page)).toHaveCount(0, { timeout: 15_000 });
  await expectHealthy(page);
});

/**
 * Proves a message the hub refuses for good says why and offers only to let
 * it go, while a lost answer still offers to send it again.
 */
test('a message the hub refuses says why and offers only 删除, never Retry', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.route('**/api/teams/*/channels/*/messages', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 403, json: {} })
      : route.continue(),
  );
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('Not allowed here');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const sent = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Not allowed here' });
  await expect(sent).toContainText('没发出去：你已不能在这个频道发消息。');
  await expect(sent.getByRole('button', { name: '重试' })).toHaveCount(0);
  await sent.getByRole('button', { name: '删除' }).click();
  await expect(sent).toHaveCount(0);
});

test('lost message response retries the same committed operation; real conflict stays visible', async ({
  page,
  context,
  hub,
}) => {
  // Nothing arrives on its own: the view reads the workspace when asked.
  await withoutStream(page);
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  let first = true;
  const keys: string[] = [];
  await page.route('**/api/teams/*/channels/*/messages', async (route) => {
    const body: unknown = route.request().postDataJSON();
    const command = z.object({ operationKey: z.string() }).parse(body);
    keys.push(command.operationKey);
    if (first) {
      first = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  // The workspace isn't read again until the retry has gone, so the
  // committed message can't arrive on its own first.
  let release: () => void = () => {
    throw new Error('Workspace read not held');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workspace?*', async (route) => {
    await held;
    await route.continue();
  });
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const text = 'One committed message, even after a lost response';
  await composer.getByLabel('消息', { exact: true }).fill(text);
  await composer.getByRole('button', { name: '发送消息' }).click();
  const sent = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: text });
  await expect(sent).toHaveAttribute('data-pending', 'failed');
  await sent.getByRole('button', { name: '重试', exact: true }).click();
  release();
  await expect(sent).not.toHaveAttribute('data-pending');
  await expect(sent).toHaveCount(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const after = await snapshot(context.request, hub.origin);
  expect(after.messages.items).toHaveLength(1);
  await page.unroute('**/api/workspace?*');
  await register(page, 'Duplicate check', 'assistant');
  // Real server uniqueness conflict, not an intercepted/fabricated error response.
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  await page
    .getByRole('list', { name: '团队', exact: true })
    .getByRole('button', { name: '添加智能体', exact: true })
    .click();
  const form = page.getByRole('form', { name: '智能体资料' });
  await form.getByLabel('智能体名称').fill('Duplicate check');
  await form.getByRole('button', { name: '添加智能体', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('已有同名的智能体');
});

test('a message shows at once and settles in place; one that didn’t go is sent again once', async ({
  page,
  context,
  hub,
}) => {
  // Sending never waits on the server: the field is free at once, the
  // message shows faded where it will stay and comes to full strength in
  // the same place; one that didn't go stays, and its retry posts it once.
  await signIn(page, hub);
  const keys: string[] = [];
  let release: () => void = () => {
    throw new Error('First message not held');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/teams/*/channels/*/messages', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body: unknown = route.request().postDataJSON();
    keys.push(z.object({ operationKey: z.string() }).parse(body).operationKey);
    if (keys.length === 1) {
      // The first is held until the test has seen it on its way.
      await held;
      await route.continue();
    } else if (keys.length === 2) await route.abort('failed');
    else await route.continue();
  });
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  const messages = page.getByRole('list', { name: '频道消息' });
  const item = (text: string) =>
    messages.getByRole('listitem').filter({ hasText: text });
  const strength = (text: string) =>
    item(text)
      .locator('.message-text')
      .evaluate((el) => getComputedStyle(el).opacity);
  await field.fill('On its way');
  await composer.getByRole('button', { name: '发送消息' }).click();
  // The field is empty and still has the focus; the message is there, faded.
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  const first = item('On its way');
  await expect(first).toHaveAttribute('data-pending', 'sending');
  expect(await strength('On its way')).toBe('0.5');
  // It arrives rising 6 px into place; measured once it is there.
  await expect
    .poll(() => first.evaluate((el) => el.getAnimations().length))
    .toBe(0);
  const box = await first.boundingBox();
  await first.evaluate((el) => {
    el.dataset.probe = 'shown';
  });
  // What is typed meanwhile stays.
  await field.fill('Written while it goes');
  release();
  await expect(first).not.toHaveAttribute('data-pending');
  // The same element, in the same place, at full strength.
  await expect(first).toHaveAttribute('data-probe', 'shown');
  expect(await first.boundingBox()).toEqual(box);
  await expect.poll(() => strength('On its way')).toBe('1');
  await expect(field).toHaveValue('Written while it goes');
  // The next one doesn't go: it stays where it was written and says so.
  await composer.getByRole('button', { name: '发送消息' }).click();
  const second = item('Written while it goes');
  await expect(second).toHaveAttribute('data-pending', 'failed');
  await expect(second).toContainText('没发出去');
  await expect(field).toHaveValue('');
  await second.getByRole('button', { name: '重试', exact: true }).click();
  await expect(second).not.toHaveAttribute('data-pending');
  await expect(second).toHaveCount(1);
  // Retried under its own key, it was posted exactly once.
  expect(keys).toHaveLength(3);
  expect(keys[2]).toBe(keys[1]);
  expect(keys[1]).not.toBe(keys[0]);
  const after = await snapshot(context.request, hub.origin);
  expect(after.messages.items.map((m) => m.body)).toEqual([
    'On its way',
    'Written while it goes',
  ]);
});

test('human claim and request-review controls, plus leave/rejoin of known membership', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Reviewer', 'reviewer');
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel || !state.agents[0])
    throw new Error('Local fixture unavailable');
  // Created, the task stays on screen as its own page.
  const task = await newTask(page, {
    title: 'Human owned task',
    criteria: ['Review requested with a recorded note'],
  });
  await task.getByRole('button', { name: '认领任务', exact: true }).click();
  await task.getByRole('button', { name: '请求审核', exact: true }).click();
  await task
    .getByLabel('接收人', { exact: true })
    .selectOption('agent:' + state.agents[0].id);
  await task.getByLabel('决定备注').fill('Please review the human work');
  await task.getByRole('button', { name: '请求审核', exact: true }).click();
  await expect(
    task.getByRole('definition').filter({ hasText: /^Reviewer$/ }),
  ).toBeVisible();
  // Esc returns from the task's page to the board, where it moved on.
  await backToBoard(page);
  await expect(inStage(page, '审核中', 'Human owned task')).toBeVisible();
  // Leaving has no place in the sidebar: it is an action in the palette.
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  await expect(
    page.locator('aside.sidebar').getByRole('button', { name: '退出频道' }),
  ).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('combobox', { name: /搜索/ });
  await search.fill('退出');
  await expect(
    page
      .getByRole('listbox', { name: '结果' })
      .getByRole('option', { name: '退出 #general' }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(search).toBeHidden();
  await expect(
    page.getByText('欢迎来到你的团队', { exact: true }),
  ).toBeVisible();
  // A channel you left is offered back by name; no IDs to copy.
  const left = page.getByRole('list', { name: '可加入的频道' });
  await expect(left.getByRole('listitem')).toHaveText([/general/]);
  // #general is public: it opens to read, with joining where the composer was.
  await left.getByRole('button', { name: 'general', exact: true }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(page.getByRole('form', { name: '给团队发消息' })).toHaveCount(0);
  await page
    .getByRole('button', { name: '加入 #general', exact: true })
    .click();
  await expect(page.getByRole('form', { name: '给团队发消息' })).toBeVisible();
  // Nothing left to join: the list disappears.
  await expect(left).toHaveCount(0);
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await expect(inStage(page, '审核中', 'Human owned task')).toBeVisible();
});

test('a heartbeat refresh never interrupts work; after a failure nothing submits until a reconnect succeeds', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel unavailable');
  await page.getByRole('button', { name: '新建频道' }).click();
  const channelName = page.getByLabel('频道名称');
  await channelName.fill('after-reconnect');
  const create = channelName.locator('xpath=ancestor::form');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill('Sent once the workspace is back');
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  /** Holds every workspace GET until released, then answers with `status`. */
  async function holdWorkspace(status: number) {
    let release: () => void = () => {
      throw new Error('Workspace request not intercepted');
    };
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.unroute('**/api/workspace?*');
    await page.route('**/api/workspace?*', async (route) => {
      await held;
      if (status === 200) await route.continue();
      else
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: '{}',
        });
    });
    return () => {
      release();
    };
  }
  async function expectNothingSubmits() {
    // The channel name has no button (Enter submits); the composer's is off.
    await expect(
      composer.getByRole('button', { name: '发送消息' }),
    ).toBeDisabled();
    for (const form of [create, composer]) {
      // Bypass native disabled controls to verify the submit handler also fails closed.
      await form.evaluate((node) =>
        node.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
      );
    }
    expect(posts).toBe(0);
  }
  // A: refreshing a confirmed snapshot changes nothing the person can do.
  const failRefresh = await holdWorkspace(503);
  await refreshNow(page);
  await expect(page.getByText('正在刷新…', { exact: true })).toBeVisible();
  await expect(composer.getByLabel('消息', { exact: true })).toBeEditable();
  await expect(
    composer.getByRole('button', { name: '发送消息' }),
  ).toBeEnabled();
  // B: once a refresh fails, the snapshot is stale and every submission stops.
  failRefresh();
  await expect(staleLine(page)).toBeVisible();
  // Typing goes on (nothing is lost); only sending waits for a confirmed snapshot.
  await expect(create.getByLabel('频道名称')).toBeEditable();
  await expect(composer.getByLabel('消息', { exact: true })).toBeEditable();
  await expectNothingSubmits();
  // B': a reconnect still in flight has not confirmed anything yet.
  const succeed = await holdWorkspace(200);
  await refreshNow(page);
  await expect(staleLine(page)).toBeVisible();
  await expect(create.getByLabel('频道名称')).toBeEditable();
  await expectNothingSubmits();
  // Asked to send anyway, the composer says why nothing went.
  await expect(composer.getByRole('alert')).toContainText('没有发送');
  // Only GET is broken: real server POST remains reachable to the authenticated owner.
  const probe = await context.request.post(
    `${hub.origin}/api/teams/${state.team.id}/channels`,
    { data: { name: 'reachable-post', operationKey: randomUUID() } },
  );
  expect(probe.status()).toBe(201);
  succeed();
  await expectHealthy(page);
  await page.unroute('**/api/workspace?*');
  await composer.getByRole('button', { name: '发送消息' }).click();
  await expect(
    page.getByText('Sent once the workspace is back', { exact: true }),
  ).toBeVisible();
  await channelName.press('Enter');
  await expect(
    page.getByRole('heading', { name: '# after-reconnect', exact: true }),
  ).toBeVisible();
  expect(posts).toBe(2);
});

test('a link that can’t open leads to the default channel, and a taken name says so', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  // A channel this person is not in, a topic that is not there and a task
  // that is not on the board are not outages: each opens what can be opened.
  for (const address of [
    '/?channel=' + randomUUID(),
    '/?topic=' + randomUUID(),
    '/?channel=' + randomUUID() + '&topic=' + randomUUID(),
  ]) {
    await page.goto(hub.origin + address);
    await expect(
      page.getByRole('heading', { name: '# general', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(hub.origin + '/');
  }
  await page.goto(hub.origin + '/?task=' + randomUUID());
  await expect(page.getByRole('region', { name: '任务看板' })).toBeVisible();
  await expect(page).toHaveURL(hub.origin + '/?view=board');
  await expect(page.getByText('工作区打不开')).toHaveCount(0);
  await expectHealthy(page);
  // A refusal is said once, where it can be acted on, in plain words.
  await page.getByRole('button', { name: '新建频道' }).click();
  await page.getByLabel('频道名称').fill('general');
  await page.getByLabel('频道名称').press('Enter');
  await expect(
    page.getByRole('navigation', { name: '频道' }).getByRole('alert'),
  ).toHaveText('这个名称已被占用');
  await expect(page.getByText(/HTTP \d/)).toHaveCount(0);
  // The refused name keeps the caret, ready to be corrected.
  await expect(page.getByLabel('频道名称')).toBeFocused();
});

test('quiet text is readable where it sits, in light and dark', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.getByRole('button', { name: '新建话题' }).click();
  await page.getByLabel('话题名称').fill('Billing');
  await page.getByLabel('话题名称').press('Enter');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('Hello');
  await composer.getByRole('button', { name: '发送消息' }).click();
  await expect(
    page.getByRole('list', { name: '频道消息' }).getByText('Hello'),
  ).toBeVisible();
  // A message's time, and a row of the tree that isn't the current place
  // ("All", here). A switched
  // scheme reaches a button through its colour transition, so the reading
  // is taken once it settles.
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const quiet of [
      '.message-body time',
      '.channel-topics button:not([aria-pressed="true"])',
    ])
      await expect
        .poll(() => contrast(page, quiet))
        .toBeGreaterThanOrEqual(4.5);
  }
});

test('the organization names the team at the top of the sidebar; nobody renames it', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const sidebar = page.locator('aside.sidebar');
  await expect(sidebar.getByText('Stand-in Co', { exact: true })).toBeVisible();
  // You are not among the sidebar's people: you know you are here.
  await expect(
    page.getByRole('region', { name: '本频道成员' }).getByText('browser_owner'),
  ).toHaveCount(0);
  // Your tile on Team is one of the team's, not a way in: what is about you
  // is your mark at the foot of the sidebar.
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  await expect(
    page
      .getByRole('list', { name: '团队' })
      .getByRole('button', { name: /^browser_owner/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '你的账户' }).click();
  await expect(
    page.getByRole('menuitem', { name: '在所有设备上退出登录' }),
  ).toBeVisible();
  // 设置 turns the sidebar into the settings map, with no channel views.
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  const map = page.getByRole('navigation', { name: '设置' });
  await expect(map.getByRole('button', { name: '通知' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('tab', { name: '聊天', exact: true }),
  ).toHaveCount(0);
  await map.getByRole('button', { name: '账户与设备' }).click();
  await expect(
    page.getByRole('button', { name: '在所有设备上退出登录' }),
  ).toBeVisible();
  // Back returns to the channel.
  await map.getByRole('button', { name: '返回' }).click();
  await expect(
    page.getByRole('tab', { name: '聊天', exact: true }),
  ).toBeVisible();
});

/**
 * Proves a settings read that fails says so instead of an empty list, and
 * reads again when asked.
 */
test('a settings section that can’t be read says so and reads again on request', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  let refuse = true;
  await page.route('**/api/me/sessions', (route) =>
    refuse ? route.fulfill({ status: 500, json: {} }) : route.continue(),
  );
  await page.getByRole('button', { name: '你的账户' }).click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  const map = page.getByRole('navigation', { name: '设置' });
  await map.getByRole('button', { name: '账户与设备' }).click();
  await expect(page.getByText('读不到登录的设备。')).toBeVisible();
  refuse = false;
  await page.getByRole('button', { name: '再试一次' }).click();
  await expect(page.getByText('读不到登录的设备。')).toHaveCount(0);
  await expect(page.getByText('此浏览器')).toBeVisible();
});

test('someone outside the organization is turned back, and a reload starts clean', async ({
  page,
  hub,
}) => {
  await page.goto(hub.origin);
  await page.getByRole('link', { name: '使用飞书登录' }).click();
  await page.getByLabel('Mailbox').fill('eve@other.com');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('这个飞书账号不属于本组织。')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  await page.reload();
  await expect(page.getByRole('link', { name: '使用飞书登录' })).toBeVisible();
  await expect(page.getByText('这个飞书账号不属于本组织。')).toHaveCount(0);
  // Someone in it, signing in next, makes the team.
  await signIn(page, hub, 'grace@example.com');
});

test('permission loss purges workspace snapshot instead of retaining stale team data', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  const privateMessage = 'Previously authorized channel message';
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill(privateMessage);
  await composer.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText(privateMessage, { exact: true })).toBeVisible();

  await newTask(page, {
    title: 'Previously authorized task',
    criteria: ['Do not display after access is revoked'],
  });
  await backToBoard(page);
  await expect(
    page.getByRole('article', { name: 'Previously authorized task' }),
  ).toBeVisible();

  let unauthorizedWorkspaceReads = 0;
  await page.route('**/api/workspace?*', async (route) => {
    unauthorizedWorkspaceReads++;
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{}',
    });
  });
  await refreshNow(page);
  await expect(page.getByRole('link', { name: '使用飞书登录' })).toBeVisible();
  await expect(page.getByText('这个账号已无权访问此工作区。')).toBeVisible();
  await expect(page.getByText(/HTTP \d/)).toHaveCount(0);
  await expect(page.getByText(privateMessage, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: 'Previously authorized task' }),
  ).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '频道' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: '给团队发消息' })).toHaveCount(0);
  expect(unauthorizedWorkspaceReads).toBeGreaterThan(0);

  // Browser response was denied while the same authenticated backend remains reachable.
  // No stale UI actions may be submitted after the access-loss transition.
  expect(
    (await context.request.get(hub.origin + '/api/workspace')).status(),
  ).toBe(200);
  expect(state.channel).not.toBeNull();
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

// All fulfilled observations below are local browser mocks, never live native acceptance.
async function openMockNativeCard(
  page: Page,
  request: APIRequestContext,
  hub: { origin: string },
) {
  // The workspace comes only from reads, which carry the mock origin.
  await withoutStream(page);
  await page.route('**/api/workspace**', async (route) => {
    // A read after the test's hub has stopped is simply lost.
    const response = await route.fetch().catch(() => null);
    if (!response) {
      await route.abort();
      return;
    }
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const data = WorkspaceSnapshot.parse(await response.json());
    await route.fulfill({
      response,
      json: { ...data, nativeT3Origin: 'https://native-mock.invalid' },
    });
  });
  await signIn(page, hub);
  await register(page, 'Mock Native Observer', 'assistant');
  const state = await snapshot(request, hub.origin);
  const agent = state.agents.find(
    (item) => item.name === 'Mock Native Observer',
  );
  if (!agent) throw new Error('Mock agent missing');
  const reference = {
    backend: 't3',
    environmentId: 'MOCK-environment',
    threadId: 'MOCK-thread',
    runId: 'MOCK-run',
  };
  const created = await request.post(
    `${hub.origin}/api/teams/${state.team.id}/agents/${agent.id}/executions`,
    {
      data: { reference, providerSessionId: null, invocationId: null },
    },
  );
  expect(created.status()).toBe(201);
  await agentRow(page, 'Mock Native Observer').click();
  await expect(page.getByText('MOCK-thread', { exact: true })).toBeVisible();
  return {
    source: 't3-native-verified',
    observedAt: '2026-10-30T12:00:00.000Z',
    reference,
    status: 'interrupted',
    terminal: true,
    threadPendingRequests: 2,
    providerId: 'MOCK-provider',
    modelId: 'MOCK-model',
    verifiedUrl: 'https://native-mock.invalid/MOCK-environment/MOCK-thread',
  };
}

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

/** `count` messages by `humanId` in a channel, "Message 1" oldest, written below the API so a long history needs no rate-limited posts. */
async function seedMessages(
  database: string,
  channelId: string,
  humanId: string,
  count: number,
) {
  const sql = rawDatabase(database);
  try {
    await sql
      .prepare(
        `INSERT INTO messages (id, channel_id, topic_id, author, created_at, body)
         SELECT gen_random_uuid()::text, ?, NULL, ?,
           to_char((now() AT TIME ZONE 'utc') - make_interval(mins => ? - g), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'Message ' || g
         FROM generate_series(1, ?) AS g ORDER BY g`,
      )
      .run(
        channelId,
        JSON.stringify({ kind: 'human', humanId }),
        count + 10,
        count,
      );
  } finally {
    await sql.close();
  }
}
/** Where a message sits in the viewport, by its exact text. */
async function topOf(page: Page, text: string) {
  const box = await page
    .getByRole('list', { name: '频道消息' })
    .getByText(text, { exact: true })
    .boundingBox();
  if (!box) throw new Error(text + ' is not on the page');
  return box.y;
}
/**
 * Reads the workspace again the way a network coming back does. Live push
 * is proven by its own tests; a measurement that only needs the new message
 * on screen does not wait on the stream's timing.
 */
const readAgain = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });
const atBottom = (page: Page) =>
  page.evaluate(
    () =>
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 48,
  );

test('a long conversation opens at its newest message, follows new ones, holds still while read back, and reads older ones by scrolling up', async ({
  page,
  context,
  hub,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  await seedMessages(hub.database, state.channel.id, state.human.id, 120);
  const messages = page.getByRole('list', { name: '频道消息' });
  const say = (text: string) => messages.getByText(text, { exact: true });
  // It opens at the newest message, with nothing to page through.
  await page.reload();
  await expect(say('Message 120')).toBeInViewport();
  expect(await atBottom(page)).toBe(true);
  await expect(say('Message 70')).toHaveCount(0);
  // Scrolling to the top reads the page before; the first message's text
  // stays exactly where it was on screen, though its header folds into the
  // same author's older messages. The read is held until its place is
  // measured.
  let release: () => void = () => {
    throw new Error('The older page was not asked for');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The older page is read, and watched, only once released.
  const reachBack = (url: URL) =>
    (url.pathname === '/api/workspace' || url.pathname === '/api/events') &&
    url.searchParams.has('messagesCursor');
  await page.route(reachBack, async (route) => {
    await held;
    await route.continue();
  });
  await page.evaluate(() => {
    window.scrollTo({ top: 0 });
  });
  // Measured at rest: the view rises into place as it opens, so read before
  // that ends, Message 71 is still on its way up.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .length,
      ),
    )
    .toBe(0);
  const first = await topOf(page, 'Message 71');
  release();
  await expect(say('Message 70')).toBeAttached();
  await page.unroute(reachBack);
  expect(Math.abs((await topOf(page, 'Message 71')) - first)).toBeLessThan(1);
  // Read back, a new message arrives at the end and nothing moves.
  const base = `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/messages`;
  const post = async (body: string) => {
    const response = await context.request.post(base, {
      data: {
        operationKey: randomUUID(),
        body,
        topicId: null,
        mentions: [],
        sourceMessageId: null,
        sourceEventId: null,
      },
    });
    expect(response.status()).toBe(201);
  };
  await post('Arrived while reading back');
  await readAgain(page);
  await expect(say('Arrived while reading back')).toBeAttached();
  expect(Math.abs((await topOf(page, 'Message 71')) - first)).toBeLessThan(1);
  // Further up, the start of the conversation.
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        window.scrollTo({ top: 0 });
      });
      return say('Message 1').count();
    })
    .toBe(1);
  // At the bottom, it stays at the bottom as messages arrive.
  await page.evaluate(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  });
  await post('Arrived at the bottom');
  await readAgain(page);
  await expect(say('Arrived at the bottom')).toBeInViewport();
  expect(await atBottom(page)).toBe(true);
  // What you send brings you back to it from anywhere.
  await page.evaluate(() => {
    window.scrollTo({ top: 0 });
  });
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('Sent from up top');
  await composer
    .getByLabel('消息', { exact: true })
    .press('ControlOrMeta+Enter');
  await expect(say('Sent from up top')).toBeInViewport();
});

test('“New since” marks only what others wrote while this channel or topic was open', async ({
  page,
  browser,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  const messages = page.getByRole('list', { name: '频道消息' });
  const divider = page
    .getByRole('separator')
    .filter({ hasText: /以来的新消息/ });
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    const graceSays = async (body: string) => {
      const response = await grace.request.post(
        `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel?.id ?? ''}/messages`,
        {
          data: {
            operationKey: randomUUID(),
            body,
            topicId: null,
            mentions: [],
            sourceMessageId: null,
            sourceEventId: null,
          },
        },
      );
      expect(response.status()).toBe(201);
    };
    await graceSays('Grace wrote before');
    await expect(messages.getByText('Grace wrote before')).toBeVisible();
    await page.getByRole('button', { name: '新建话题' }).click();
    await page.getByLabel('话题名称').fill('Billing');
    await page.getByLabel('话题名称').press('Enter');
    const composer = page.getByRole('form', { name: '给团队发消息' });
    await composer.getByLabel('消息', { exact: true }).fill('In the topic');
    await composer.getByRole('button', { name: '发送消息' }).click();
    await expect(
      messages.getByRole('listitem').filter({ hasText: 'In the topic' }),
    ).not.toHaveAttribute('data-pending');
    // Reloaded inside the topic, then widened to All: what Grace wrote
    // before is not new, only out of the topic.
    await page.reload();
    await expect(messages.getByText('In the topic')).toBeVisible();
    await page
      .getByRole('list', { name: '话题' })
      .getByRole('button', { name: '全部', exact: true })
      .click();
    await expect(messages.getByText('Grace wrote before')).toBeVisible();
    await expect(divider).toHaveCount(0);
    // What she writes now is.
    await graceSays('Grace wrote this');
    await readAgain(page);
    await expect(
      messages.getByRole('listitem').filter({ hasText: 'Grace wrote this' }),
    ).toContainText('以来的新消息');
    await expect(divider).toHaveCount(1);
  } finally {
    await theirs.close();
  }
});

test('a task older than the board’s newest still opens by its address', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const oldest = await newTask(page, {
    title: 'The oldest task',
    criteria: ['Still reachable'],
  });
  await expect(oldest).toBeVisible();
  const state = await snapshot(context.request, hub.origin);
  const task = state.tasks.items[0];
  if (!task) throw new Error('Task missing');
  // A hundred newer tasks, copied from it below the API.
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        `INSERT INTO tasks (id, team_id, channel_id, topic_id, title, description, criteria, creator,
           acceptor_human_id, state, status, owner_key, version, created_at, updated_at)
         SELECT gen_random_uuid()::text, team_id, channel_id, topic_id, 'Newer task ' || g, description,
           criteria, creator, acceptor_human_id, state, status, owner_key, version, created_at, updated_at
         FROM tasks, generate_series(1, 100) AS g WHERE id = ? ORDER BY g`,
      )
      .run(task.id);
  } finally {
    await sql.close();
  }
  await page.goto(hub.origin + '/?task=' + task.id);
  await expect(taskPage(page, 'The oldest task')).toBeVisible();
  // The board shows the newest tasks, with nothing to page through.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '任务看板' })).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Newer task 100', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'The oldest task', exact: true }),
  ).toHaveCount(0);
});

/**
 * Whether taps up to 21 px above, below, left and right of an element's
 * centre land on it: a 44 px target, however small it is drawn.
 */
function takesTaps(page: Page, selector: string) {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) throw new Error('Nothing matches ' + target);
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return [
      [x, y - 21],
      [x, y + 21],
      [x - 21, y],
      [x + 21, y],
    ].map(([px = 0, py = 0]) => {
      const hit = document.elementFromPoint(px, py);
      return hit !== null && (hit === element || element.contains(hit));
    });
  }, selector);
}

test('a phone channel: targets a finger can hit, fields that don’t zoom, a composer on the bottom edge', async ({
  browser,
  hub,
}) => {
  const phone = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await phone.newPage();
    await signIn(page, hub);
    const state = await snapshot(page.request, hub.origin);
    if (!state.channel) throw new Error('Local channel missing');
    await page.getByRole('button', { name: '新建话题' }).click();
    await page.getByLabel('话题名称').fill('Billing');
    await page.getByLabel('话题名称').press('Enter');
    await page
      .getByRole('list', { name: '话题' })
      .getByRole('button', { name: '全部', exact: true })
      .click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page
      .getByRole('navigation', { name: '频道' })
      .getByRole('button', { name: 'general', exact: true })
      .click();
    const topics = page.getByRole('group', { name: '话题' });
    await expect(topics.getByRole('button', { name: 'Billing' })).toBeVisible();
    // Back keeps no chrome, so it is drawn at 44 px; the rest take taps
    // around them.
    const back = await page
      .getByRole('button', { name: '返回', exact: true })
      .boundingBox();
    expect(back?.width).toBeGreaterThanOrEqual(44);
    expect(back?.height).toBeGreaterThanOrEqual(44);
    for (const target of [
      '.view-switch [role="tab"]',
      '.topic-pills button[aria-pressed="false"]',
      '.topic-pills .topic-add',
    ])
      expect(await takesTaps(page, target)).toEqual([true, true, true, true]);
    // A pill and the "+" after it are one height.
    const heights = await page
      .locator('.topic-pills button')
      .evaluateAll((pills) =>
        pills.map((pill) => Math.round(pill.getBoundingClientRect().height)),
      );
    expect(new Set(heights).size).toBe(1);
    // Leaving is not among the topics a thumb taps all day; it waits where
    // the conversation begins.
    await expect(topics.getByRole('button', { name: '退出频道' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('button', { name: '退出频道', exact: true }),
    ).toBeVisible();
    // The field is 16 px (iOS zooms below that) and takes the width; Send is
    // the round confirm, shown once there is something to send.
    const composer = page.getByRole('form', { name: '给团队发消息' });
    const field = composer.getByLabel('消息', { exact: true });
    expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      '16px',
    );
    const send = composer.getByRole('button', { name: '发送消息' });
    await expect(send).toBeDisabled();
    await field.fill('Ship the release notes');
    await expect(send).toBeEnabled();
    // Only the paperclip, "@" and Send sit beside it: the rest is the
    // field's, but for the composer's padding and gaps. Widths are laid out,
    // not drawn, so Send growing in doesn't count.
    const width = (target: typeof field) =>
      target.evaluate((el) => (el instanceof HTMLElement ? el.offsetWidth : 0));
    const [fieldWidth, formWidth, attachWidth, atWidth, sendWidth] =
      await Promise.all([
        width(field),
        width(composer),
        width(composer.getByRole('button', { name: '添加文件' })),
        width(composer.getByRole('button', { name: '提及成员' })),
        width(send),
      ]);
    expect(fieldWidth + attachWidth + atWidth + sendWidth).toBeGreaterThan(
      formWidth - 56,
    );
    // Send grows in once there is something to send: measure it grown.
    await expect
      .poll(() => send.evaluate((el) => el.getAnimations().length))
      .toBe(0);
    expect(await takesTaps(page, '.composer button[type="submit"]')).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // "@" and Send share a centre.
    const centre = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.top + box.height / 2;
      });
    expect(
      Math.abs(
        (await centre('.composer .mention-trigger')) -
          (await centre('.composer button[type="submit"]')),
      ),
    ).toBeLessThan(1);
    await send.tap();
    const posted = page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: 'Ship the release notes' });
    await expect(posted).toBeVisible();
    // On touch, a message shows what can be done with it once tapped.
    const makeTask = posted.getByRole('button', { name: '转为任务' });
    await expect(makeTask).toBeHidden();
    await posted.getByText('Ship the release notes').tap();
    await expect(makeTask).toBeVisible();
    // A long conversation scrolls behind the composer, which sits on the
    // bottom edge over paper: no message shows below it.
    await seedMessages(hub.database, state.channel.id, state.human.id, 40);
    await readAgain(page);
    await expect(
      page.getByRole('list', { name: '频道消息' }).getByText('Message 40'),
    ).toBeVisible();
    await page.evaluate(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight / 2 });
    });
    const edge = await page.evaluate(() => {
      const composer = document.querySelector('.composer');
      const under = document.elementFromPoint(
        window.innerWidth / 2,
        window.innerHeight - 2,
      );
      return {
        bottom: composer?.getBoundingClientRect().bottom,
        masked: under !== null && composer?.contains(under) === true,
      };
    });
    expect(edge).toEqual({ bottom: 812, masked: true });
  } finally {
    await phone.close();
  }
});

test('said once: a topic’s messages carry no tag for it, and one place is current at a time', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.getByRole('button', { name: '新建话题' }).click();
  await page.getByLabel('话题名称').fill('Billing');
  await page.getByLabel('话题名称').press('Enter');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('In the topic');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const posted = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'In the topic' });
  await expect(posted).toBeVisible();
  await expect(posted.getByText('Billing', { exact: true })).toHaveCount(0);
  const topics = page.getByRole('list', { name: '话题' });
  const billing = topics.getByRole('button', { name: 'Billing', exact: true });
  const channelRow = page
    .getByRole('navigation', { name: '频道' })
    .getByRole('button', { name: 'general', exact: true });
  const fill = (row: typeof billing) =>
    row.evaluate((el) => getComputedStyle(el).backgroundColor);
  const clear = 'rgba(0, 0, 0, 0)';
  // In a topic, the topic carries the fill and its channel only its ink.
  await expect(billing).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(0, 0);
  await expect.poll(() => fill(billing)).not.toBe(clear);
  await expect.poll(() => fill(channelRow)).toBe(clear);
  // "All" is the whole channel: the channel row is the place, never "All".
  const all = topics.getByRole('button', { name: '全部', exact: true });
  await all.click();
  await expect(posted.getByText('Billing', { exact: true })).toBeVisible();
  await expect(all).not.toHaveAttribute('aria-pressed');
  await expect(billing).toHaveAttribute('aria-pressed', 'false');
  await expect(channelRow).toHaveAttribute('aria-current', 'page');
  await page.mouse.move(0, 0);
  await expect.poll(() => fill(channelRow)).not.toBe(clear);
  await expect.poll(() => fill(all)).toBe(clear);
  // The fill is a row's, not a card's: same height, no border.
  const box = await channelRow.evaluate((el) => ({
    border: getComputedStyle(el).borderTopColor,
    height: el.getBoundingClientRect().height,
  }));
  expect(box.border).toBe(clear);
  // On Team the place is Team: neither the channel nor a topic is current,
  // and the row keeps its height.
  await billing.click();
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  await expect(billing).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.locator('nav[aria-label="频道"] [aria-current="page"]'),
  ).toHaveCount(0);
  expect(
    await channelRow.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(box.height);
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await expect(billing).toHaveAttribute('aria-pressed', 'true');
});

test('a fenced code block is one block, not a box around every line', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill(
      'Run this:\n```\nnpm ci\nnpm run build\nnpm start\n```\nthen `npm test`',
    );
  await composer.getByRole('button', { name: '发送消息' }).click();
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Run this:' });
  const block = message.locator('pre');
  await expect(block).toHaveText('npm ci\nnpm run build\nnpm start');
  // The block has the one sunken background; the code in it is a single
  // box with no border, background or padding of its own.
  const shape = await block.evaluate((pre) => {
    const code = pre.querySelector('code');
    if (!code) throw new Error('no code in the block');
    const style = getComputedStyle(code);
    return {
      pre: getComputedStyle(pre).backgroundColor,
      boxes: code.getClientRects().length,
      border: style.borderTopWidth,
      background: style.backgroundColor,
      padding: style.paddingLeft,
    };
  });
  expect(shape.pre).not.toBe('rgba(0, 0, 0, 0)');
  expect(shape).toMatchObject({
    boxes: 1,
    border: '0px',
    background: 'rgba(0, 0, 0, 0)',
    padding: '0px',
  });
  // Inline code outside a block keeps its own box.
  const inline = message.locator('p code', { hasText: 'npm test' });
  await expect(inline).toBeVisible();
  expect(
    await inline.evaluate((el) => getComputedStyle(el).borderTopWidth),
  ).toBe('1px');
});

/**
 * Proves any message can be reached: one far older than the workspace's
 * window opens from its address, shown in its conversation, also after a
 * reload; scrolling back reaches the channel's first message; and a
 * message's link is that address.
 */
test('a message far back opens from its address, stays across a reload, and the start is reachable', async ({
  page,
  context,
  hub,
}) => {
  test.setTimeout(90_000);
  const lastCopied = await recordCopies(page);
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  const channelId = state.channel.id;
  // Older history than the window holds: 260 messages, oldest first.
  const ids = Array.from({ length: 260 }, () => randomUUID());
  const sql = rawDatabase(hub.database);
  try {
    for (const [n, id] of ids.entries())
      await sql
        .prepare(
          'INSERT INTO messages (id, channel_id, topic_id, author, created_at, body) VALUES (?, ?, NULL, ?, ?, ?)',
        )
        .run(
          id,
          channelId,
          JSON.stringify({ kind: 'human', humanId: state.human.id }),
          new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
          'History ' + String(n),
        );
  } finally {
    await sql.close();
  }
  const row = (n: number) => page.locator('#message-' + String(ids[n]));
  // Its address opens the channel at it, however far back.
  await page.goto(
    `${hub.origin}/?channel=${channelId}&message=${String(ids[3])}`,
  );
  await expect(row(3)).toBeInViewport({ timeout: 20_000 });
  await expect(row(3)).toContainText('History 3');
  await page.reload();
  await expect(row(3)).toBeInViewport({ timeout: 20_000 });
  // Scrolling back reaches the channel's very first message.
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, -20_000);
        return row(0).count();
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  await expect(row(0)).toContainText('History 0');
  // It is the beginning: nothing above it.
  await expect(
    page.locator('.messages > li[id^="message-"]').first(),
  ).toHaveAttribute('id', 'message-' + String(ids[0]));
  // A message's link is that address.
  await row(3).hover();
  await row(3)
    .locator('.message-actions')
    .getByRole('button', { name: '复制链接' })
    .click();
  expect(await lastCopied()).toBe(
    `${hub.origin}/?channel=${channelId}&message=${String(ids[3])}`,
  );
});

/**
 * Proves a person can reply to a message: 回复 puts it above the field, the
 * reply carries it and quotes it, and the quote opens it.
 */
test('a reply names the message it answers, quotes it, and the quote opens it', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  const say = async (text: string) => {
    await field.fill(text);
    await composer.getByRole('button', { name: '发送消息' }).click();
  };
  const item = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text })
      .first();
  await say('The original question');
  await expect(item('The original question')).toBeVisible();
  await say('Something else in between');
  await expect(item('Something else in between')).toBeVisible();
  await item('The original question').hover();
  await item('The original question')
    .locator('.message-actions')
    .getByRole('button', { name: '回复' })
    .click();
  await expect(composer.locator('.composer-reply')).toContainText(
    'The original question',
  );
  await expect(field).toBeFocused();
  await say('The answer');
  await expect(composer.locator('.composer-reply')).toHaveCount(0);
  const answer = item('The answer');
  const quote = answer.locator('button.reply-to');
  await expect(quote).toContainText('The original question');
  const source = (
    await snapshot(context.request, hub.origin)
  ).messages.items.find((m) => m.body === 'The original question');
  await expect
    .poll(
      async () =>
        (await snapshot(context.request, hub.origin)).messages.items.find(
          (m) => m.body === 'The answer',
        )?.sourceMessageId,
    )
    .toBe(source?.id);
  await quote.click();
  await expect(item('The original question')).toBeInViewport();
});

/**
 * Proves a code block and a message each copy as written: the code without
 * the button's word, the message as its Markdown.
 */
test('a code block and a message each copy as written', async ({
  page,
  hub,
}) => {
  const lastCopied = await recordCopies(page);
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const body = 'Run **this**:\n```sh\nnpm ci\nnpm start\n```';
  await composer.getByLabel('消息', { exact: true }).fill(body);
  await composer.getByRole('button', { name: '发送消息' }).click();
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Run' });
  const block = message.locator('.code-block');
  await block.hover();
  // By its place: its name becomes 已复制 once pressed.
  const copyCode = block.locator('.code-copy');
  await copyCode.click();
  await expect(copyCode).toHaveText('已复制');
  expect(await lastCopied()).toBe('npm ci\nnpm start');
  await message.hover();
  await message
    .locator('.message-actions')
    .getByRole('button', { name: '复制', exact: true })
    .click();
  expect(await lastCopied()).toBe(body);
});

/**
 * Proves the Files list keeps what was read: a change in the workspace
 * rereads the newest page without dropping older pages, and no file is
 * listed twice.
 */
test('the Files list keeps older pages through a change and lists each file once', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  const channelId = state.channel.id;
  const file = (name: string, createdAt: string) => ({
    attachment: {
      id: randomUUID(),
      name,
      type: 'text/plain',
      size: 3,
      width: null,
      height: null,
    },
    channelId,
    messageId: randomUUID(),
    uploader: state.human.id,
    createdAt,
  });
  const a = file('a.txt', '2026-11-02T00:00:00.000Z');
  const b = file('b.txt', '2026-11-01T00:00:00.000Z');
  const c = file('c.txt', '2026-11-03T00:00:00.000Z');
  // MOCK the file list only: page one, the page before it, then a new file.
  let firstReads = 0;
  await page.route('**/api/teams/*/files*', (route) => {
    if (route.request().url().includes('before='))
      return route.fulfill({ json: { items: [b], next: null } });
    firstReads++;
    return route.fulfill({
      json: { items: firstReads === 1 ? [a] : [c, a], next: 7 },
    });
  });
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  const list = page.getByRole('list', { name: '文件' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: '更早的文件' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  // A change anywhere (a message here) rereads the newest page; the older
  // one stays.
  const posted = await context.request.post(
    `${hub.origin}/api/teams/${state.team.id}/channels/${channelId}/messages`,
    {
      data: {
        operationKey: randomUUID(),
        body: 'A change',
        topicId: null,
        mentions: [],
        sourceMessageId: null,
        sourceEventId: null,
        attachments: [],
      },
    },
  );
  expect(posted.status()).toBe(201);
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('listitem')).toHaveText([
    /c\.txt/,
    /a\.txt/,
    /b\.txt/,
  ]);
});

test('a pasted image and a chosen file go with a message: the image as it is, the file as a row that downloads', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  // A file chosen with the paperclip, and an image pasted into the text.
  await composer.locator('input[type="file"]').setInputFiles({
    name: 'build.log',
    mimeType: 'text/plain',
    buffer: Buffer.from('line 1\nline 2\n'),
  });
  await composer.getByLabel('消息', { exact: true }).evaluate((field) => {
    const pixel = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const files = new DataTransfer();
    files.items.add(new File([pixel], 'pixel.png', { type: 'image/png' }));
    field.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: files, bubbles: true }),
    );
  });
  const attached = composer.getByRole('list', { name: '附件' });
  await expect(attached.getByRole('listitem')).toHaveCount(2);
  // Files alone are enough to send, once they are all there.
  const send = composer.getByRole('button', { name: '发送消息' });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(attached).toHaveCount(0);
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('list', { name: '图片' }) })
    .last();
  const image = message.getByRole('img', { name: 'pixel.png' });
  await expect(image).toBeVisible();
  // It holds its place: its own pixels, given before it loads.
  expect(await image.getAttribute('width')).toBe('1');
  expect(
    await image.evaluate((img) =>
      img instanceof HTMLImageElement ? img.naturalWidth : 0,
    ),
  ).toBe(1);
  const row = message.getByRole('link', { name: /build\.log/ });
  await expect(row).toHaveAttribute('download', 'build.log');
  await expect(row).toContainText('14 B');
  // On the message's text edge.
  const edge = async (locator: typeof row) =>
    Math.round((await locator.boundingBox())?.x ?? -1);
  expect(await edge(image)).toBe(await edge(message.locator('.message-body')));
  expect(await edge(row)).toBe(await edge(image));
});

/**
 * Proves the keyboard sends no sooner than Send: while a file is still
 * uploading, ⌘/Ctrl+Enter leaves the message and the file in the composer.
 */
test('⌘/Ctrl+Enter waits for a file still uploading, as Send does', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/attachments/uploads', async (route) => {
    await held;
    await route.continue();
  });
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  await field.fill('The log is attached');
  await composer.locator('input[type="file"]').setInputFiles({
    name: 'run.log',
    mimeType: 'text/plain',
    buffer: Buffer.from('ok\n'),
  });
  const attached = composer.getByRole('list', { name: '附件' });
  await expect(attached.getByRole('listitem')).toHaveCount(1);
  await field.press('ControlOrMeta+Enter');
  const messages = page.getByRole('list', { name: '频道消息' });
  await expect(field).toHaveValue('The log is attached');
  await expect(attached.getByRole('listitem')).toHaveCount(1);
  await expect(messages.getByText('The log is attached')).toHaveCount(0);
  // Once it is up, the same key sends both.
  release();
  await expect(
    composer.getByRole('button', { name: '发送消息' }),
  ).toBeEnabled();
  await field.press('ControlOrMeta+Enter');
  const sent = messages
    .getByRole('listitem')
    .filter({ hasText: 'The log is attached' });
  await expect(sent.getByRole('link', { name: /run\.log/ })).toBeVisible();
});

test('one author’s run of messages is one group: the face and name once, each time on hover, a new day says so', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  // Something said yesterday, so today opens under its own date.
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        `INSERT INTO messages (id, channel_id, topic_id, author, created_at, body)
         VALUES (gen_random_uuid()::text, ?, NULL, ?,
           to_char((now() AT TIME ZONE 'utc') - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'Said yesterday')`,
      )
      .run(
        state.channel.id,
        JSON.stringify({ kind: 'human', humanId: state.human.id }),
      );
  } finally {
    await sql.close();
  }
  await page.reload();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const messages = page.getByRole('list', { name: '频道消息' });
  const item = (text: string) =>
    messages.getByRole('listitem').filter({ hasText: text });
  // Each is sent once the one before has arrived.
  for (const body of ['First of a group', 'Second of a group']) {
    await composer.getByLabel('消息', { exact: true }).fill(body);
    await composer.getByRole('button', { name: '发送消息' }).click();
    await expect(item(body)).toBeVisible();
    await expect(item(body)).not.toHaveAttribute('data-pending');
  }
  // The days are separators, in order; yesterday's message is not grouped
  // with today's.
  const days = messages.getByRole('separator');
  await expect(days.filter({ hasText: '昨天' })).toHaveCount(1);
  await expect(days.filter({ hasText: '今天' })).toHaveCount(1);
  await expect(item('First of a group').locator('header')).toHaveCount(1);
  await expect(item('First of a group').locator('.avatar')).toHaveCount(1);
  // The second message sits under the first: no face, no name line…
  const second = item('Second of a group');
  await expect(second.locator('header')).toHaveCount(0);
  await expect(second.locator('.avatar')).toHaveCount(0);
  // …and its text starts on the first one's text edge.
  const edge = async (text: string) =>
    (await messages.getByText(text, { exact: true }).boundingBox())?.x;
  expect(await edge('Second of a group')).toBe(await edge('First of a group'));
  // Its time is always there for a screen reader, with its author, and
  // shown only while the message is pointed at.
  const time = second.locator('time');
  await expect(time).toHaveAttribute('datetime', /T/);
  const author = await item('First of a group')
    .locator('header strong')
    .textContent();
  expect(author).toBeTruthy();
  await expect(time).toContainText(author ?? '');
  await page.mouse.move(0, 0);
  await expect
    .poll(() => time.evaluate((el) => getComputedStyle(el).opacity))
    .toBe('0');
  await second.hover();
  await expect
    .poll(() => time.evaluate((el) => getComputedStyle(el).opacity))
    .toBe('1');
});

/**
 * Proves the Markdown agents write lays out inside its message: a nested
 * list, a task list and a wide table, with no sideways page scroll.
 */
test('a reply with a nested list, a task list and a wide table lays out inside its message', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const wide = Array.from({ length: 12 }, (_, i) => `column ${String(i)}`);
  await composer
    .getByLabel('消息', { exact: true })
    .fill(
      [
        'Plan:',
        '',
        '- ship',
        '  - **build**',
        '  - ~~old step~~',
        '',
        '- [x] tests pass',
        '- [ ] docs updated',
        '',
        '| ' + wide.join(' | ') + ' |',
        '| ' + wide.map(() => '-').join(' | ') + ' |',
        '| ' + wide.map((_, i) => String(i)).join(' | ') + ' |',
      ].join('\n'),
    );
  await composer.getByRole('button', { name: '发送消息' }).click();
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Plan:' })
    .first();
  const body = message.locator('.message-text');
  await expect(body.locator('ul ul li')).toHaveCount(2);
  await expect(body.locator('del')).toHaveText('old step');
  const boxes = body.getByRole('checkbox');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.first()).toBeChecked();
  await expect(boxes.first()).toBeDisabled();
  const table = body.getByRole('region', { name: '表格' });
  await expect(table.getByRole('cell', { name: '11' })).toHaveCount(1);
  const [row, region] = await Promise.all([
    message.boundingBox(),
    table.boundingBox(),
  ]);
  expect(row && region && region.x + region.width <= row.x + row.width).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

/**
 * Proves code is highlighted in its declared language, and the highlighter
 * loads only once a message has such a block.
 */
test('code in a declared language is highlighted, and the highlighter loads only for it', async ({
  page,
  hub,
}) => {
  const loaded: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/assets/lowlight-')) loaded.push(request.url());
  });
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const say = async (body: string) => {
    await composer.getByLabel('消息', { exact: true }).fill(body);
    await composer.getByRole('button', { name: '发送消息' }).click();
  };
  const item = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text });
  await say('Plain words, and `inline` code only');
  await expect(item('Plain words')).toBeVisible();
  expect(loaded).toHaveLength(0);
  await say('Typed:\n```ts\nconst answer: number = 42; // the answer\n```');
  const code = item('Typed:').locator('pre code.language-ts');
  await expect(code.locator('.hljs-keyword').first()).toHaveText('const');
  await expect(code.locator('.hljs-number')).toHaveText('42');
  await expect(code.locator('.hljs-comment')).toHaveText('// the answer');
  expect(loaded.length).toBeGreaterThan(0);
  // A language it doesn't know stays plain code.
  await say('Odd:\n```nosuchlang\nkeep me\n```');
  const odd = item('Odd:').locator('pre code.language-nosuchlang');
  await expect(odd).toHaveText('keep me');
  await expect(odd.locator('span')).toHaveCount(0);
});

test('a mermaid block is drawn as its diagram, and one that can’t be drawn stays its code', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const say = async (body: string) => {
    await composer.getByLabel('消息', { exact: true }).fill(body);
    await composer.getByRole('button', { name: '发送消息' }).click();
  };
  const messages = page.getByRole('list', { name: '频道消息' });
  const item = (text: string) =>
    messages.getByRole('listitem').filter({ hasText: text });
  // A label's line break (`<br/>`, which Mermaid writes as HTML) is drawn too.
  await say(
    'Drawn:\n```mermaid\nflowchart LR\n  A["Proposed<br/>by Ada"] --> B[Done]\n```',
  );
  // An image, drawn from an SVG that runs nothing, where the code was.
  const drawing = item('Drawn:').getByRole('img', { name: '图表' });
  await expect(drawing).toBeVisible();
  await expect(drawing).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect
    .poll(() => drawing.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(item('Drawn:').locator('pre')).toHaveCount(0);
  // A block that can't be drawn is shown as the code it is, and says
  // nothing else; a fence keeps its language either way.
  await say('Broken:\n```mermaid\nflowchart LR\n  A[never closed -->\n```');
  const code = item('Broken:').locator('pre code.language-mermaid');
  await expect(code).toHaveText('flowchart LR\n  A[never closed -->');
  await expect(item('Broken:').getByRole('img')).toHaveCount(0);
  await expect(item('Broken:')).not.toContainText(/error/i);
  await say('Typed:\n```ts\nconst x = 1;\n```');
  await expect(item('Typed:').locator('pre code.language-ts')).toHaveText(
    'const x = 1;',
  );
});

/**
 * Proves a criterion row removed with Backspace is gone from the kept draft
 * too: a reload brings back exactly the rows left.
 */
test('a criterion row removed with Backspace stays removed after a reload', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await page.getByRole('button', { name: '新任务' }).click();
  const form = page.getByRole('form', { name: '新任务' });
  await form.getByLabel('任务标题').fill('Ship it');
  const first = form.getByLabel('完成标准', { exact: true });
  await first.fill('Tests pass');
  await first.press('Enter');
  const second = form.getByLabel('完成标准 2', { exact: true });
  await expect(second).toBeFocused();
  await second.press('Backspace');
  await expect(second).toHaveCount(0);
  await page.reload();
  const restored = page.getByRole('form', { name: '新任务' });
  await expect(restored.getByLabel('完成标准', { exact: true })).toHaveValue(
    'Tests pass',
  );
  await expect(restored.getByLabel('完成标准 2', { exact: true })).toHaveCount(
    0,
  );
});

test('a reload keeps the place and unsent work; Back returns to where you were', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('half a thought');
  await page.reload();
  await expect(composer.getByLabel('消息', { exact: true })).toHaveValue(
    'half a thought',
  );
  // A new task half written survives a reload, in place.
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await page.getByRole('button', { name: '新任务' }).click();
  const form = page.getByRole('form', { name: '新任务' });
  await form.getByLabel('任务标题').fill('Write the release notes');
  await form.getByLabel('完成标准').fill('Notes published');
  await expect(page).toHaveURL(/task=new/);
  await page.reload();
  await expect(form.getByLabel('任务标题')).toHaveValue(
    'Write the release notes',
  );
  await expect(form.getByLabel('完成标准')).toHaveValue('Notes published');
  await form.getByRole('button', { name: '创建任务', exact: true }).click();
  // Created, it is its own address; a reload opens it again.
  const task = page.getByRole('region', {
    name: 'Write the release notes',
    exact: true,
  });
  await expect(task).toBeVisible();
  await expect(page).toHaveURL(/task=[0-9a-f-]{36}/);
  await page.reload();
  await expect(task).toBeVisible();
  // The Inbox is a place too, and Back leaves it for the task again.
  await page
    .getByRole('navigation', { name: '收件箱' })
    .getByRole('button', { name: /^收件箱/ })
    .click();
  await expect(page).toHaveURL(/inbox/);
  await page.goBack();
  await expect(task).toBeVisible();
});

test('one control opens and closes the sidebar: it floats on an upright tablet and docks on a wide screen', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.setViewportSize({ width: 768, height: 1024 });
  const sidebar = page.locator('aside.sidebar');
  const open = page.getByRole('button', { name: '展开侧栏', exact: true });
  const close = sidebar.getByRole('button', { name: '收起侧栏', exact: true });
  // Upright, it starts closed and the content has the whole width.
  await expect(sidebar).toBeHidden();
  const header = await page.locator('.workspace-header').boundingBox();
  expect(header && header.x < 24).toBe(true);
  // Opened, it floats over the content, which does not move; the control
  // now ends the team name's row.
  await open.click();
  await expect(sidebar).toBeVisible();
  await expect(close).toBeFocused();
  expect(await page.locator('.workspace-header').boundingBox()).toEqual(header);
  // A click outside, Esc, or its own control closes it.
  await page.mouse.click(700, 600);
  await expect(sidebar).toBeHidden();
  await open.click();
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  await expect(open).toBeFocused();
  await open.click();
  await close.click();
  await expect(sidebar).toBeHidden();
  // Wide, it starts open as a column beside the content, and the same
  // control closes it; this device remembers.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(sidebar).toBeVisible();
  const [aside, main] = await Promise.all([
    sidebar.boundingBox(),
    page.locator('.workspace-main').boundingBox(),
  ]);
  expect(aside && main && aside.x + aside.width <= main.x).toBe(true);
  await close.click();
  await expect(sidebar).toBeHidden();
  await page.reload();
  await expect(open).toBeVisible();
  await expect(sidebar).toBeHidden();
});
test('a wide tablet keeps the board, one stage, beside the task that is open', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await page.getByRole('button', { name: '新任务' }).first().click();
  const task = page.getByRole('region', { name: '新任务', exact: true });
  await expect(task).toBeVisible();
  // The board stays, one stage at a time, and the page leads back by touch:
  // the task has no back bar, the 看板 tab lit above it closes it.
  const board = page.getByRole('region', { name: '任务看板' });
  await expect(board).toBeVisible();
  await expect(board.getByRole('group', { name: '阶段' })).toBeVisible();
  const [left, right] = await Promise.all([
    board.boundingBox(),
    task.boundingBox(),
  ]);
  expect(left && right && left.x + left.width <= right.x).toBe(true);
  await expect(
    task.getByRole('button', { name: '返回', exact: true }),
  ).toBeHidden();
  const boardTab = page.getByRole('tab', { name: '看板', exact: true });
  await expect(boardTab).toHaveAttribute('aria-selected', 'true');
  await boardTab.click();
  await expect(task).toHaveCount(0);
  await expect(board).toBeVisible();
});

test('a new team is guided through its first steps, each with the control that does it', async ({
  page,
  hub,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, hub);
  const guide = page.getByRole('region', { name: '开始使用' });
  await expect(guide).toBeVisible();
  // Nothing is done yet: three steps, the first one's control adds an agent.
  const steps = guide.getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.first()).not.toContainText('已完成');
  await guide.getByRole('button', { name: '添加', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: '成员', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  // It sits in the conversation's column, on its text edge.
  await page.getByRole('tab', { name: '聊天', exact: true }).click();
  const [box, list] = await Promise.all([
    guide.boundingBox(),
    page.getByRole('list', { name: '频道消息' }).boundingBox(),
  ]);
  expect(Math.round(box?.x ?? -1)).toBe(Math.round(list?.x ?? -2));
});
