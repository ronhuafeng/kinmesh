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
  await channels.getByRole('button', { name: 'design', exact: true }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: '退出 #design' }).click();
  // Left: the sidebar offers it among the channels you may join.
  await expect(page.getByRole('form', { name: '加入 design' })).toBeVisible();
  await page.getByRole('button', { name: '你的账户' }).click();
  await page.getByRole('menuitem', { name: /^设置/ }).click();
  await page
    .getByRole('navigation', { name: '设置' })
    .getByRole('button', { name: '频道', exact: true })
    .click();
  await page
    .getByRole('list', { name: '已退出的频道' })
    .getByRole('button', { name: '重新加入' })
    .click();
  // It opens, back among your channels.
  await expect(
    page
      .getByRole('navigation', { name: '频道' })
      .getByRole('button', { name: 'design', exact: true }),
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
