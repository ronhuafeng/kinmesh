import type { Page } from '@playwright/test';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixture.js';
import {
  agentRow,
  backToBoard,
  createChannel,
  newTask,
  refreshNow,
  register,
  signIn,
  taskPage,
} from './ui.js';
import {
  snapshot,
  withoutStream,
  outOfReach,
  expectHealthy,
  contrast,
  readAgain,
} from './helpers.js';

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
 * Proves a person's face opens your own conversation with them, listed by
 * their face and name, and the other person finds it under yours.
 */
test('a person’s face opens your own conversation with them', async ({
  page,
  browser,
  hub,
}) => {
  await signIn(page, hub, 'ada@example.com');
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    await page
      .getByRole('region', { name: '本频道成员' })
      .locator('.person')
      .filter({ hasText: 'Grace Hopper' })
      .click();
    const row = page
      .locator('aside.sidebar')
      .getByRole('link', { name: 'Grace Hopper', exact: true });
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(row.locator('.avatar')).toBeVisible();
    const composer = page.getByRole('form', { name: '给团队发消息' });
    await composer.getByLabel('消息', { exact: true }).fill('Just between us');
    await composer.getByRole('button', { name: '发送消息' }).click();
    const said = (p: typeof page) =>
      p.getByRole('list', { name: '频道消息' }).getByText('Just between us');
    await expect(said(page)).toBeVisible();
    // Grace finds it under Ada's name; it is theirs alone.
    await grace
      .locator('aside.sidebar')
      .getByRole('link', { name: 'ada', exact: true })
      .click();
    await expect(said(grace)).toBeVisible();
    await expect(
      grace.getByRole('region', { name: '本频道成员' }).locator('.person'),
    ).toHaveCount(1);
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
    await page.getByRole('link', { name: '成员', exact: true }).click();
    const add = page.getByRole('button', {
      name: '把 Grace Hopper 加入 #design',
    });
    await add.click();
    await expect(graceRow).toBeVisible();
    await expect(add).toHaveCount(0);
    // The @ popover finds her by a word of her name, and the message says
    // her name once, with no second chip.
    await page.getByRole('link', { name: '聊天', exact: true }).click();
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
        .getByRole('link', { name: 'design', exact: true }),
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
    page.getByRole('link', { name: '成员', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
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
  await page.getByRole('link', { name: '聊天', exact: true }).click();
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
  // Healthy is silent. Out of reach is said in the top bar with nothing to
  // press, nothing in it speaks HTTP, and nothing under the bar moves.
  await expectHealthy(page);
  const contentTop = () =>
    page
      .locator('.view-content')
      .evaluate((el) => el.getBoundingClientRect().top);
  const before = await contentTop();
  await context.setOffline(true);
  await refreshNow(page);
  await expect(outOfReach(page)).toBeVisible();
  await expect(page.locator('.workspace-header')).toContainText(
    '连不上 Kinmesh',
  );
  expect(await contentTop()).toBe(before);
  await expect(
    page.getByRole('button', { name: /重新连接|再试一次|重试/ }),
  ).toHaveCount(0);
  // Asking again while still out of reach keeps the honest state.
  await refreshNow(page);
  await expect(outOfReach(page)).toBeVisible();
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
  await page.getByRole('link', { name: '账户与设备', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('link', { name: '使用飞书登录' })).toBeVisible();
});

/**
 * Proves the dark colours, now written once, are the same whether dark is
 * the system's choice or the person's, and light stays light.
 */
test('dark is the same colours whether the system or the person chose it', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const colours = () =>
    page.evaluate(() => {
      const probe = document.createElement('span');
      document.body.append(probe);
      const out: Record<string, string> = {};
      for (const token of ['--canvas', '--paper', '--ink', '--primary']) {
        probe.style.color = `var(${token})`;
        out[token] = getComputedStyle(probe).color;
      }
      probe.remove();
      return out;
    });
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await colours();
  expect(light['--canvas']).toBe('rgb(242, 242, 247)');
  await page.emulateMedia({ colorScheme: 'dark' });
  const system = await colours();
  expect(system['--canvas']).toBe('rgb(0, 0, 0)');
  // Chosen in settings (外观), over a light system.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  expect(await colours()).toEqual(system);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await colours()).toEqual(light);
});

/**
 * Proves a channel is renamed in place from its row's menu, archived (it
 * leaves the sidebar, still opens from Settings, without a composer), and
 * brought back.
 */
test('a channel is renamed in place, archived, opened from Settings, and brought back', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await createChannel(page, 'design');
  const channels = page.getByRole('navigation', { name: '频道' });
  await channels
    .getByRole('link', { name: 'design', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名…' }).click();
  const field = channels.getByLabel('频道名称');
  await field.fill('launch');
  await field.press('Enter');
  const launch = channels.getByRole('link', { name: 'launch', exact: true });
  await expect(launch).toBeVisible();
  await launch.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^归档 #launch/ }).click();
  await page.getByRole('menuitem', { name: /^确认：从列表移走/ }).click();
  await expect(launch).toHaveCount(0);
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  await page
    .getByRole('navigation', { name: '设置' })
    .getByRole('link', { name: '频道', exact: true })
    .click();
  await page
    .getByRole('list', { name: '已归档的频道' })
    .getByRole('button', { name: /launch/ })
    .first()
    .click();
  await expect(page.getByText('#launch 已归档。')).toBeVisible();
  await expect(page.getByRole('form', { name: '给团队发消息' })).toHaveCount(0);
  await page.getByRole('button', { name: '恢复频道' }).click();
  await expect(page.getByRole('form', { name: '给团队发消息' })).toBeVisible();
  await expect(launch).toBeVisible();
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
  await expect(
    page.getByRole('status').filter({ hasText: 'Ada 提到了你' }),
  ).toBeVisible();
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
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
  await page.getByRole('menuitem', { name: '暂停 1 小时' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '没能改好，请再试一次。' }),
  ).toBeVisible();
  // Out of reach, signing out says why it waits instead of doing nothing.
  await context.setOffline(true);
  await refreshNow(page);
  await expect(outOfReach(page)).toBeVisible();
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
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
  await expect(outOfReach(page)).toHaveCount(0);
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
  await expect(outOfReach(page)).toBeVisible({ timeout: 15_000 });
  // The page asks again every 5 seconds while out of reach.
  hold = false;
  await expect(outOfReach(page)).toHaveCount(0, { timeout: 15_000 });
  await expectHealthy(page);
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
  await expect(outOfReach(page)).toBeVisible();
  // Typing goes on (nothing is lost); only sending waits for a confirmed snapshot.
  await expect(create.getByLabel('频道名称')).toBeEditable();
  await expect(composer.getByLabel('消息', { exact: true })).toBeEditable();
  await expectNothingSubmits();
  // B': a reconnect still in flight has not confirmed anything yet.
  const succeed = await holdWorkspace(200);
  await refreshNow(page);
  await expect(outOfReach(page)).toBeVisible();
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
  await page.getByRole('link', { name: '成员', exact: true }).click();
  await expect(
    page
      .getByRole('list', { name: '团队' })
      .getByRole('button', { name: /^browser_owner/ }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
  await expect(
    page.getByRole('menuitem', { name: '在所有设备上退出登录' }),
  ).toBeVisible();
  // 设置 turns the sidebar into the settings map, with no channel views.
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  const map = page.getByRole('navigation', { name: '设置' });
  await expect(map.getByRole('link', { name: '通知' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('link', { name: '聊天', exact: true }),
  ).toHaveCount(0);
  await map.getByRole('link', { name: '账户与设备' }).click();
  await expect(
    page.getByRole('button', { name: '在所有设备上退出登录' }),
  ).toBeVisible();
  // Back returns to the channel.
  await map.getByRole('button', { name: '返回' }).click();
  await expect(
    page.getByRole('link', { name: '聊天', exact: true }),
  ).toBeVisible();
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
  await page.getByRole('link', { name: '文件', exact: true }).click();
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
  await page.getByRole('link', { name: '看板', exact: true }).click();
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
/**
 * Proves the app's back is Back: a task's page closed with its back returns
 * to the board's own history entry, so history doesn't grow and the
 * browser's Back then leaves the channel instead of opening the task again.
 */
test('a page’s back returns to the entry it came from, so Back then leaves the channel', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const title = 'Write the changelog';
  await newTask(page, { title, criteria: ['Changelog published'] });
  await backToBoard(page);
  await createChannel(page, 'ops');
  await page.getByRole('link', { name: '看板', exact: true }).click();
  await page
    .getByRole('navigation', { name: '频道' })
    .getByRole('link', { name: /^general( |$)/ })
    .click();
  await expect(
    page.getByRole('heading', { name: '# general', exact: true }),
  ).toBeAttached();
  await expect(page.getByRole('region', { name: '任务看板' })).toBeVisible();
  const board = page.url();
  // On a phone, where a page has its own way back.
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('article', { name: title, exact: true })
    .getByRole('link', { name: title, exact: true })
    .click();
  const task = taskPage(page, title);
  await expect(task).toBeVisible();
  const length = await page.evaluate(() => history.length);
  await task.getByRole('button', { name: '返回' }).click();
  await expect(task).toHaveCount(0);
  await expect(page).toHaveURL(board);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: '# ops', exact: true }),
  ).toBeAttached();
  await expect(task).toHaveCount(0);
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

/**
 * Proves focus never falls to the start of the page: Esc on the Inbox and
 * on a task's page gives focus back to what opened them, and Esc in a field
 * typed in place (a PR's address, a new topic) gives it back to the "+"
 * the field stood in for. The PR field is a URL field.
 */
test('closing a page or a field typed in place gives focus back to what opened it', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const inboxButton = page
    .getByRole('navigation', { name: '收件箱' })
    .getByRole('button', { name: /^收件箱/ });
  await inboxButton.click();
  const inbox = page.getByRole('region', { name: '收件箱' });
  await expect(inbox).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(inbox).toHaveCount(0);
  await expect(inboxButton).toBeFocused();
  // A field typed in place on a task's page.
  const task = await newTask(page, {
    title: 'Ship the notes',
    criteria: ['The notes are out'],
  });
  await task.getByRole('button', { name: '关联 PR' }).click();
  const address = task.getByLabel('PR 地址');
  await expect(address).toBeFocused();
  await expect(address).toHaveAttribute('type', 'url');
  await page.keyboard.press('Escape');
  await expect(address).toHaveCount(0);
  await expect(task.getByRole('button', { name: '关联 PR' })).toBeFocused();
  await backToBoard(page);
  // A task opened from its card by keyboard closes back onto the card.
  const card = page
    .getByRole('article', { name: 'Ship the notes', exact: true })
    .getByRole('link', { name: 'Ship the notes', exact: true });
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(taskPage(page, 'Ship the notes')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(taskPage(page, 'Ship the notes')).toHaveCount(0);
  await expect(card).toBeFocused();
  // A new topic's field, Esc'd, gives focus back to its "+".
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  await page.getByRole('button', { name: '新建话题' }).click();
  await expect(page.getByLabel('话题名称')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '新建话题' })).toBeFocused();
});

/**
 * Proves a notice waits while it is pointed at or focused, and goes in its
 * own time once let go: the page's clock runs past its 8 s while held.
 */
test('a notice waits while it is pointed at or focused', async ({
  page,
  hub,
}) => {
  await page.clock.install();
  await withoutStream(page);
  await signIn(page, hub);
  await page.route('**/api/workspace?*', async (route) => {
    const response = await route.fetch();
    const body = z.record(z.string(), z.unknown()).parse(await response.json());
    await route.fulfill({
      response,
      json: {
        ...body,
        revision: 'e'.repeat(64),
        notices: [{ id: 'n1', title: 'Ada 提到了你', body: 'first', url: '/' }],
      },
    });
  });
  await refreshNow(page);
  const notice = page.getByRole('button', { name: /Ada 提到了你/ });
  await notice.hover();
  await page.clock.runFor(10_000);
  await expect(notice).toBeVisible();
  await page.mouse.move(0, 0);
  await notice.focus();
  await page.clock.runFor(10_000);
  await expect(notice).toBeVisible();
  await notice.blur();
  await page.clock.runFor(10_000);
  await expect(notice).toHaveCount(0);
});

/**
 * Proves the screen reader hears what the screen shows: the account button
 * is named by the person's name on it, and what the top bar says about the
 * connection comes from one status region that is there, empty, while all
 * is well.
 */
test('the account is named as shown, and the connection is said from a region always there', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await expect(
    page.getByRole('button', { name: 'browser_owner', exact: true }),
  ).toContainText('browser_owner');
  const said = page.locator('.workspace-header').getByRole('status');
  await expect(said).toHaveText('');
  // The same node, filled: a region that was already there is announced.
  await said.evaluate((el) => {
    el.setAttribute('data-probe', 'before');
  });
  await context.setOffline(true);
  await refreshNow(page);
  await expect(said).toHaveText('连不上 Kinmesh');
  await expect(said).toHaveAttribute('data-probe', 'before');
  await context.setOffline(false);
  await expectHealthy(page);
});

/**
 * Proves search keeps the highlighted result in view and says what it
 * found: arrowing past what the list shows scrolls it along, the results
 * are grouped by kind in the accessibility tree, and the count (or that
 * nothing matched) is a polite status.
 */
test('search keeps the highlighted result in view, grouped and counted', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  for (let i = 1; i <= 16; i++) {
    const made = await context.request.post(
      `${hub.origin}/api/teams/${state.team.id}/channels`,
      {
        data: {
          name: 'room-' + String(i).padStart(2, '0'),
          visibility: 'public',
          operationKey: randomUUID(),
        },
      },
    );
    expect(made.ok()).toBe(true);
  }
  await readAgain(page);
  await expect(
    page
      .getByRole('navigation', { name: '频道' })
      .getByRole('link', { name: /^room-16( |$)/ }),
  ).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('combobox', { name: /搜索/ });
  await search.fill('room');
  const results = page.getByRole('listbox', { name: '结果' });
  const channels = results.getByRole('group', { name: '频道' });
  await expect(channels.getByRole('option')).toHaveCount(16);
  await expect(
    page.getByRole('status').filter({ hasText: '个结果' }),
  ).toHaveText('16 个结果');
  for (let i = 0; i < 15; i++) await search.press('ArrowDown');
  const active = results.getByRole('option', { selected: true });
  await expect(active).toHaveAccessibleName(/room-16/);
  const inside = await active.evaluate((option) => {
    const list = option.closest('[role="listbox"]');
    if (!list) return false;
    const box = option.getBoundingClientRect();
    const view = list.getBoundingClientRect();
    // Within the list's own box, to the pixel.
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  });
  expect(inside).toBe(true);
  await search.fill('nothing like this');
  await expect(
    page.getByRole('status').filter({ hasText: '没有和' }),
  ).toBeVisible();
});

/**
 * Proves signing out leaves nothing of the last person in the tab: whoever
 * signs in there next finds neither their draft nor their unsent message,
 * so it can't be read, or sent again as theirs.
 */
test('signing out leaves no draft or unsent message for whoever signs in next in the tab', async ({
  page,
  hub,
}) => {
  await signIn(page, hub, 'ada@example.com');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  const messages = page.getByRole('list', { name: '频道消息' });
  // A message that didn't go waits to be sent again; a draft is half typed.
  const send = '**/api/teams/*/channels/*/messages';
  await page.route(send, (route) =>
    route.request().method() === 'POST'
      ? route.abort('failed')
      : route.continue(),
  );
  await field.fill('Ada’s unsent message');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const unsent = messages
    .getByRole('listitem')
    .filter({ hasText: 'Ada’s unsent message' });
  await expect(unsent).toHaveAttribute('data-pending', 'failed');
  await page.unroute(send);
  await field.fill('Ada’s half-written draft');
  await page.getByRole('button', { name: 'ada', exact: true }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('link', { name: '使用飞书登录' })).toBeVisible();
  // Someone else signs in, in the same tab.
  await signIn(page, hub, 'grace@example.com');
  await expect(field).toHaveValue('');
  await expect(messages.getByText('Ada’s unsent message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
});

/**
 * Proves what the page says about days stays true as time passes with
 * nothing new arriving: past midnight, yesterday's divider says 昨天, and a
 * card due on the day that has just ended is late.
 */
test('a tab left open past midnight says 昨天 and marks a due day gone by as late', async ({
  page,
  hub,
}) => {
  await page.clock.install({ time: new Date() });
  await signIn(page, hub);
  const now = await page.evaluate(() => Date.now());
  /** The local day `days` after today, as a due date says it. */
  const day = (days: number) => {
    const at = new Date(now);
    at.setDate(at.getDate() + days);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  };
  /** How long from the page's now until just into the given local day. */
  const until = async (days: number) => {
    const at = new Date(now);
    at.setDate(at.getDate() + days);
    at.setHours(0, 1, 0, 0);
    return at.getTime() - (await page.evaluate(() => Date.now()));
  };
  await newTask(page, {
    title: 'Due tomorrow',
    criteria: ['Done by then'],
    due: day(1),
  });
  await backToBoard(page);
  const due = page
    .getByRole('article', { name: 'Due tomorrow', exact: true })
    .locator('time');
  await expect(due).not.toHaveAttribute('data-late');
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill('Said before midnight');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const messages = page.getByRole('list', { name: '频道消息' });
  // Settled: the conversation has the message, and nothing more is coming.
  const said = messages
    .getByRole('listitem')
    .filter({ hasText: 'Said before midnight' });
  await expect(said).toBeVisible();
  await expect(said).not.toHaveAttribute('data-pending');
  await expectHealthy(page);
  const divider = messages.locator('.day-divider');
  await expect(divider).toHaveText(['今天']);
  // Midnight passes with the conversation on screen.
  await page.clock.fastForward(await until(1));
  await expect(divider).toHaveText(['昨天']);
  // The task is due today; once today has ended, with the board on screen,
  // it is late.
  await page.getByRole('link', { name: '看板', exact: true }).click();
  await expect(due).not.toHaveAttribute('data-late');
  await page.clock.fastForward(await until(2));
  await expect(due).toHaveAttribute('data-late', 'true');
});

/**
 * Stands in for the tab being hidden and shown again (a headless browser
 * never hides one), and records the app's badge as the browser would show
 * it.
 */
async function visibilityAndBadge(page: Page) {
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(Document.prototype, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    window.addEventListener('test-visibility', (event) => {
      hidden = event instanceof CustomEvent && event.detail === 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const badges: (number | boolean | null)[] = [];
    Reflect.set(window, '__badges', badges);
    Object.defineProperty(navigator, 'setAppBadge', {
      configurable: true,
      value: (count?: number) => {
        badges.push(count ?? true);
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, 'clearAppBadge', {
      configurable: true,
      value: () => {
        badges.push(null);
        return Promise.resolve();
      },
    });
  });
  return {
    hide: (hidden: boolean) =>
      page.evaluate(
        (detail) => {
          window.dispatchEvent(new CustomEvent('test-visibility', { detail }));
        },
        hidden ? 'hidden' : 'visible',
      ),
    badge: async () =>
      z
        .array(z.union([z.number(), z.boolean(), z.null()]))
        .parse(
          await page.evaluate((): unknown => Reflect.get(window, '__badges')),
        )
        .at(-1),
  };
}
/** A number the page keeps under `name`. */
const counted = async (page: Page, name: string) =>
  z
    .number()
    .parse(
      await page.evaluate((key): unknown => Reflect.get(window, key), name),
    );

/**
 * Proves a hidden tab doesn't draw every change: snapshots arriving while
 * it is hidden change nothing on the page, though the badge follows them;
 * shown again, the newest is on screen.
 */
test('a hidden tab draws no change until shown, then the newest, while its badge stays current', async ({
  page,
  browser,
  context,
  hub,
}) => {
  const tab = await visibilityAndBadge(page);
  await signIn(page, hub, 'ada@example.com');
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    const state = await snapshot(context.request, hub.origin);
    if (!state.channel) throw new Error('Local channel missing');
    const base = `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/messages`;
    const messages = page.getByRole('list', { name: '频道消息' });
    await expectHealthy(page);
    await expect.poll(tab.badge).not.toBe(true);
    // Whatever changes the conversation on screen is counted from here.
    await page.evaluate(() => {
      const list = document.querySelector('.messages');
      if (!list) throw new Error('No conversation');
      let changes = 0;
      Reflect.set(window, '__changes', changes);
      new MutationObserver((records) => {
        changes += records.length;
        Reflect.set(window, '__changes', changes);
      }).observe(list, { childList: true, subtree: true, characterData: true });
    });
    await tab.hide(true);
    for (const n of [1, 2, 3]) {
      const sent = await theirs.request.post(base, {
        data: {
          operationKey: randomUUID(),
          body: `From Grace ${String(n)}`,
          topicId: null,
          mentions: [],
          sourceMessageId: null,
          sourceEventId: null,
        },
      });
      expect(sent.status()).toBe(201);
    }
    // The badge says something is unread, from what arrived hidden...
    await expect.poll(tab.badge).toBe(true);
    // ...and the conversation on screen didn't change.
    expect(await counted(page, '__changes')).toBe(0);
    await expect(messages.getByText(/^From Grace/)).toHaveCount(0);
    await tab.hide(false);
    await expect(messages.getByText(/^From Grace/)).toHaveText([
      'From Grace 1',
      'From Grace 2',
      'From Grace 3',
    ]);
  } finally {
    await theirs.close();
  }
});

/**
 * Proves a hidden tab out of reach doesn't keep asking: no retries while
 * nobody sees it, and one at once when it is shown.
 */
test('a hidden tab out of reach asks again only once it is shown', async ({
  page,
  hub,
}) => {
  const tab = await visibilityAndBadge(page);
  await page.clock.install({ time: new Date() });
  await signIn(page, hub);
  // Each read of the workspace the page asks for, counted as it asks.
  await page.evaluate(() => {
    let reads = 0;
    Reflect.set(window, '__reads', reads);
    const fetching = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (url.pathname === '/api/workspace')
        Reflect.set(window, '__reads', ++reads);
      return fetching(input, init);
    };
  });
  const reads = () => counted(page, '__reads');
  await page.route('**/api/workspace?*', (route) => route.abort('failed'));
  await refreshNow(page);
  await expect(outOfReach(page)).toBeVisible();
  await tab.hide(true);
  const hidden = await reads();
  // A minute passes hidden: twelve retries' worth, and none is made.
  await page.clock.fastForward('01:00');
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve));
      }),
  );
  expect(await reads()).toBe(hidden);
  // Shown again, it asks at once.
  await tab.hide(false);
  await expect.poll(reads).toBeGreaterThan(hidden);
});

/**
 * Proves channels and views are links to their addresses: a plain click
 * opens one in place, a modified click opens the same address in a new tab
 * and leaves this one be, the view on screen is the current page, and the
 * title names each place.
 */
test('channels and views are links to their places, and the title names each', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await expect(page).toHaveTitle('# general · Kinmesh');
  const channels = page.getByRole('navigation', { name: '频道' });
  const general = channels.getByRole('link', { name: 'general', exact: true });
  const href = (await general.getAttribute('href')) ?? '';
  expect(href).toMatch(/^\/\?channel=[^&]+$/);
  await createChannel(page, 'design');
  await expect(page).toHaveTitle('# design · Kinmesh');
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    general.click({ modifiers: ['ControlOrMeta'] }),
  ]);
  await expect(tab).toHaveURL(hub.origin + href);
  await expect(tab).toHaveTitle('# general · Kinmesh');
  await tab.close();
  await expect(page).toHaveTitle('# design · Kinmesh');
  await general.click();
  await expect(general).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(hub.origin + href);
  await expect(page).toHaveTitle('# general · Kinmesh');
  // The views are navigation: links to the channel's views.
  const views = page.getByRole('navigation', { name: '工作区视图' });
  const chat = views.getByRole('link', { name: '聊天', exact: true });
  const board = views.getByRole('link', { name: '看板', exact: true });
  await expect(chat).toHaveAttribute('aria-current', 'page');
  await expect(board).toHaveAttribute('href', href + '&view=board');
  await board.click();
  await expect(board).toHaveAttribute('aria-current', 'page');
  await expect(chat).not.toHaveAttribute('aria-current');
  await expect(page).toHaveURL(hub.origin + href + '&view=board');
  await expect(page).toHaveTitle('看板 · # general · Kinmesh');
  await expect(chat).toHaveAttribute('href', href);
});

/**
 * Proves search offers every action a channel's and a member's menu holds,
 * each run by keyboard alone: renaming in place, making it private,
 * taking an agent out, archiving.
 */
test('every channel and member action runs from search by keyboard alone', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await createChannel(page, 'design');
  await register(page, 'Ada', 'developer');
  const run = async (typed: string, option: string | RegExp) => {
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: /搜索/ }).fill(typed);
    await expect(
      page
        .getByRole('listbox', { name: '结果' })
        .getByRole('option', { name: option }),
    ).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
  };
  const channels = page.getByRole('navigation', { name: '频道' });
  // Renamed in its row, the old name ready to type over.
  await run('重命名', '重命名 #design');
  await expect(channels.getByLabel('频道名称')).toBeFocused();
  await page.keyboard.type('launch');
  await page.keyboard.press('Enter');
  await expect(
    channels.getByRole('link', { name: 'launch', exact: true }),
  ).toBeVisible();
  // Private, then search offers to open it again.
  await run('设为私密', '设为私密 #launch');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: /搜索/ }).fill('设为公开');
  await expect(
    page
      .getByRole('listbox', { name: '结果' })
      .getByRole('option', { name: /^设为公开 #launch/ }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  // A member taken out.
  const people = page.getByRole('region', { name: '本频道成员' });
  await expect(people.getByRole('button', { name: /Ada/ })).toBeVisible();
  await run('移出', '把 Ada 移出 #launch');
  await expect(people.getByRole('button', { name: /Ada/ })).toHaveCount(0);
  // Archived: out of the list.
  await run('归档', /^归档 #launch/);
  await expect(
    channels.getByRole('link', { name: 'launch', exact: true }),
  ).toHaveCount(0);
});

/**
 * Proves a channel row says in words what its weight, grey and bell show:
 * unread, muted, followed.
 */
test('a channel row says it is unread, muted or followed', async ({
  page,
  browser,
  hub,
}) => {
  await signIn(page, hub, 'ada@example.com');
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    await createChannel(page, 'design');
    const composer = grace.getByRole('form', { name: '给团队发消息' });
    await composer.getByLabel('消息', { exact: true }).fill('News for all');
    await composer.getByRole('button', { name: '发送消息' }).click();
  } finally {
    await theirs.close();
  }
  const channels = page.getByRole('navigation', { name: '频道' });
  const general = channels.getByRole('link', { name: /^general/ });
  await expect(general).toHaveAccessibleName(/未读/);
  const design = channels.getByRole('link', { name: /^design/ });
  await expect(design).not.toHaveAccessibleName(/未读|已静音|每条消息/);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: /搜索/ }).fill('静音 #design');
  await page.keyboard.press('Enter');
  await expect(design).toHaveAccessibleName(/已静音/);
  await page.keyboard.press('ControlOrMeta+k');
  await page
    .getByRole('combobox', { name: /搜索/ })
    .fill('每条消息都通知 #design');
  await page.keyboard.press('Enter');
  await expect(design).toHaveAccessibleName(/每条消息都通知你/);
  await expect(design).not.toHaveAccessibleName(/已静音/);
});

/**
 * Proves the sign-in screen fits a phone's visible height: no vertical
 * scroll when its content fits.
 */
test('the sign-in screen fits a phone without scrolling', async ({
  page,
  hub,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(hub.origin);
  await expect(page.getByRole('link', { name: '使用飞书登录' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight,
    ),
  ).toBe(true);
});

/**
 * Proves the due day and priority fields of a task show where focus is,
 * and that in forced colours a focused field and the current place keep an
 * outline.
 */
test('focus and the current place stay visible, also in forced colours', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  await page.goto(`${hub.origin}/?channel=${state.channel?.id ?? ''}&task=new`);
  const due = page.getByLabel('截止日期', { exact: true });
  await expect(due).toBeVisible();
  await page.getByLabel('任务标题').focus();
  // Tab until the due day is reached, as a keyboard user would.
  for (let n = 0; n < 20; n++) {
    if (await due.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  const ring = (selector: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s) ?? document.activeElement;
      if (!el) return 'none';
      const style = getComputedStyle(el);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    }, selector);
  expect(await ring(':focus')).toBe('solid 2px');
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await ring('[aria-current="page"]')).toBe('solid 2px');
  await page.getByLabel('任务标题').focus();
  expect(await ring(':focus')).toBe('solid 2px');
});

/**
 * Proves text follows the person's font size: at the browser's default it
 * measures as designed, and with a larger default every size grows with it.
 */
test('text follows the browser’s font size', async ({ page, hub }) => {
  await signIn(page, hub);
  const sizes = () =>
    page.evaluate(() =>
      [
        document.body,
        document.querySelector('.composer textarea'),
        document.querySelector('.sidebar nav button'),
      ].map((el) => (el ? parseFloat(getComputedStyle(el).fontSize) : 0)),
    );
  const before = await sizes();
  expect(before[0]).toBe(16);
  // What a larger default font size in the browser's settings does.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  const after = await sizes();
  for (const [index, size] of before.entries())
    expect(after[index]).toBeCloseTo(size * 1.25, 1);
});
