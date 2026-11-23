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
} from './ui.js';
import {
  snapshot,
  withoutStream,
  staleLine,
  expectHealthy,
  contrast,
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
      .getByRole('button', { name: 'Grace Hopper', exact: true });
    await expect(row).toHaveAttribute('aria-current', 'page');
    await expect(row.locator('.avatar')).toBeVisible();
    const composer = page.getByRole('form', { name: '给团队发消息' });
    await composer.getByLabel('消息', { exact: true }).fill('Just between us');
    await composer.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('Just between us')).toBeVisible();
    // Grace finds it under Ada's name; it is theirs alone.
    await grace
      .locator('aside.sidebar')
      .getByRole('button', { name: 'ada', exact: true })
      .click();
    await expect(grace.getByText('Just between us')).toBeVisible();
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
    .getByRole('button', { name: 'design', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名…' }).click();
  const field = channels.getByLabel('频道名称');
  await field.fill('launch');
  await field.press('Enter');
  const launch = channels.getByRole('button', { name: 'launch', exact: true });
  await expect(launch).toBeVisible();
  await launch.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^归档 #launch/ }).click();
  await page.getByRole('menuitem', { name: /^确认：从列表移走/ }).click();
  await expect(launch).toHaveCount(0);
  await page.getByRole('button', { name: '你的账户' }).click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  await page
    .getByRole('navigation', { name: '设置' })
    .getByRole('button', { name: '频道', exact: true })
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
