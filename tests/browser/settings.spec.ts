import type { Page } from '@playwright/test';
import { z } from 'zod';
import { test, expect } from './fixture.js';
import { createChannel, register, signIn } from './ui.js';

/**
 * Proves a member can be taken out of a channel from their row's menu, and
 * a channel you left can be joined again from Settings.
 */
test('an agent is taken out of a channel from its row, and a left channel is rejoined from Settings', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await createChannel(page, 'design');
  await register(page, 'Ada', 'developer');
  const people = page.getByRole('region', { name: '本频道成员' });
  const ada = people.getByRole('button', { name: /Ada/ });
  await expect(ada).toBeVisible();
  await ada.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '把 Ada 移出 #design' }).click();
  await expect(ada).toHaveCount(0);
  // Left, then joined again from Settings → 频道.
  const channels = page.getByRole('navigation', { name: '频道' });
  await channels.getByRole('link', { name: 'design', exact: true }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: '退出 #design' }).click();
  // Left: the sidebar offers it among the channels you may join.
  await expect(page.getByRole('form', { name: '加入 design' })).toBeVisible();
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  await page
    .getByRole('navigation', { name: '设置' })
    .getByRole('link', { name: '频道', exact: true })
    .click();
  await page
    .getByRole('list', { name: '已退出的频道' })
    .getByRole('button', { name: '重新加入' })
    .click();
  // It opens, back among your channels.
  await expect(
    page
      .getByRole('navigation', { name: '频道' })
      .getByRole('link', { name: 'design', exact: true }),
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
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  const map = page.getByRole('navigation', { name: '设置' });
  await map.getByRole('link', { name: '账户与设备' }).click();
  await expect(page.getByText('读不到登录的设备。')).toBeVisible();
  refuse = false;
  await page.getByRole('button', { name: '再试一次' }).click();
  await expect(page.getByText('读不到登录的设备。')).toHaveCount(0);
  await expect(page.getByText('此浏览器')).toBeVisible();
});

/**
 * Proves a choice keeps focus while it saves: the option pressed stays
 * focused and enabled until the hub answers (a second press is ignored by
 * the request itself), and what the row does is its description to a
 * screen reader, not only a hover title.
 */
test('a choice keeps focus while it saves, and says what it does', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  let release: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/me/forward', async (route) => {
    await answered;
    await route.continue();
  });
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  const forward = page.getByRole('group', { name: '转发到飞书' });
  await expect(forward).toHaveAccessibleDescription(
    '通知这段时间里还没读，就由飞书机器人私信你',
  );
  const later = forward.getByRole('button', { name: '10 分钟后' });
  await later.focus();
  await page.keyboard.press('Enter');
  // Saving: still the focused, enabled control.
  await expect(later).toBeFocused();
  await expect(later).toBeEnabled();
  release();
  await expect(later).toHaveAttribute('aria-pressed', 'true');
  await expect(later).toBeFocused();
});

/** Opens a section of Settings from your menu. */
async function openSettings(page: Page, section: string) {
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  await page
    .getByRole('navigation', { name: '设置' })
    .getByRole('link', { name: section, exact: true })
    .click();
}

/**
 * Proves an install offer is spent once it has prompted: turned down,
 * 安装到桌面 is gone, rather than a button that does nothing, until the
 * browser offers again.
 */
test('an install turned down leaves no dead 安装到桌面 until the browser offers again', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  // The browser offering to install, as Chrome does; its prompt is turned
  // down, and counted.
  const offer = () =>
    page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: () => {
          const prompted: unknown = Reflect.get(window, '__prompted');
          Reflect.set(
            window,
            '__prompted',
            (typeof prompted === 'number' ? prompted : 0) + 1,
          );
          return Promise.resolve();
        },
        userChoice: Promise.resolve({ outcome: 'dismissed' }),
      });
      window.dispatchEvent(event);
    });
  await offer();
  await openSettings(page, '通知');
  const install = page.getByRole('button', { name: '安装到桌面' });
  await install.click();
  expect(
    await page.evaluate((): unknown => Reflect.get(window, '__prompted')),
  ).toBe(1);
  await expect(install).toHaveCount(0);
  await offer();
  await expect(install).toBeVisible();
});

/**
 * Proves a pairing code goes when it expires, from one timer at that
 * moment: nothing ticks every second meanwhile.
 */
test('a pairing code goes once it expires, with nothing ticking every second', async ({
  page,
  hub,
}) => {
  await page.clock.install({ time: new Date() });
  // Every repeating timer the page starts, by its interval.
  await page.addInitScript(() => {
    const every: number[] = [];
    Reflect.set(window, '__intervals', every);
    const repeat = window.setInterval.bind(window);
    Reflect.set(
      window,
      'setInterval',
      (handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
        every.push(timeout ?? 0);
        return repeat(handler, timeout, ...rest);
      },
    );
  });
  // The team's T3 is connected and pairs browsers.
  await page.route('**/api/teams/*/t3', (route) =>
    route.fulfill({
      json: {
        connection: {
          endpoint: 'https://t3.example.com/mcp',
          environmentId: 'environment',
          connectedAt: new Date().toISOString(),
          access: 'operate',
          ceiling: 'full-access',
          expired: false,
        },
        signIn: null,
        authorizationUrl: null,
        pasteCallback: false,
        provisioned: false,
        pairing: true,
        revision: 'r1',
      },
    }),
  );
  await signIn(page, hub);
  const expiresAt = new Date(
    (await page.evaluate(() => Date.now())) + 10 * 60_000,
  ).toISOString();
  await page.route('**/api/teams/*/t3/pair', (route) =>
    route.fulfill({
      json: {
        token: 'PAIR-2468',
        expiresAt,
        url: 'https://t3.example.com/pair#token=PAIR-2468',
      },
    }),
  );
  await openSettings(page, '连接');
  await page.getByRole('button', { name: '生成配对码' }).click();
  const code = page.getByText('PAIR-2468', { exact: true });
  await expect(code).toBeVisible();
  expect(
    z
      .array(z.number())
      .parse(
        await page.evaluate((): unknown => Reflect.get(window, '__intervals')),
      )
      .filter((ms) => ms <= 1000),
  ).toEqual([]);
  // Just before it expires it is still there; once it has, it is gone.
  await page.clock.fastForward('09:30');
  await expect(code).toBeVisible();
  await page.clock.fastForward('00:31');
  await expect(code).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成配对码' })).toBeVisible();
});

/**
 * Proves 外观 is followed everywhere: chosen in one tab, the page and its
 * title-bar colour change there and in another open tab, against the
 * system's choice, and 跟随系统 hands both back to the system.
 */
test('外观 chosen in one tab changes every open tab and the title bar', async ({
  page,
  context,
  hub,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page, hub);
  const other = await context.newPage();
  await other.emulateMedia({ colorScheme: 'light' });
  await other.goto(hub.origin);
  const titleBar = (p: Page) =>
    p.evaluate(
      () =>
        [
          ...document.querySelectorAll<HTMLMetaElement>(
            'meta[name="theme-color"]',
          ),
        ].find((meta) => window.matchMedia(meta.media || 'all').matches)
          ?.content,
    );
  const light = await titleBar(page);
  await openSettings(page, '外观');
  const choose = (name: string) =>
    page.getByRole('button', { name, exact: true }).click();
  await choose('深色');
  for (const p of [page, other]) {
    await expect(p.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(() => titleBar(p)).not.toBe(light);
  }
  await choose('跟随系统');
  for (const p of [page, other]) {
    await expect(p.locator('html')).not.toHaveAttribute('data-theme', /./);
    await expect.poll(() => titleBar(p)).toBe(light);
  }
});

/**
 * Proves a settings section is a link to its address: a modified click
 * opens that section in a new tab, a plain one opens it here, and the
 * title names it.
 */
test('a settings section is a link to its address, and the title names it', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await page
    .getByRole('button', { name: 'browser_owner', exact: true })
    .click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  const map = page.getByRole('navigation', { name: '设置' });
  const appearance = map.getByRole('link', { name: '外观' });
  const href = await appearance.getAttribute('href');
  expect(href).toMatch(/^\/\?(channel=[^&]+&)?settings=appearance$/);
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    appearance.click({ modifiers: ['ControlOrMeta'] }),
  ]);
  await expect(tab).toHaveURL(hub.origin + (href ?? ''));
  await expect(
    tab
      .getByRole('navigation', { name: '设置' })
      .getByRole('link', { name: '外观' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(tab).toHaveTitle('外观 · 设置 · Kinmesh');
  await tab.close();
  // Here nothing moved.
  await expect(map.getByRole('link', { name: '通知' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await appearance.click();
  await expect(appearance).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(hub.origin + (href ?? ''));
  await expect(page).toHaveTitle('外观 · 设置 · Kinmesh');
});
