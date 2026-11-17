import { expect, type Page } from '@playwright/test';

/**
 * The workspace as a person drives it. The CI browser suite and the paid
 * live driver (tests/live/hub.ts) share these, so a renamed control fails
 * in CI before it can break a live run.
 */
/**
 * Sign in through Feishu's stand-in, choosing who to be there; ends in
 * #general. The first person to sign in makes the team.
 */
export async function signIn(
  page: Page,
  hub: { origin: string },
  mailbox = 'browser_owner@example.com',
) {
  await page.goto(hub.origin);
  await page.getByRole('link', { name: '使用飞书登录' }).click();
  await page.getByLabel('Mailbox').fill(mailbox);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('heading', { name: '# general', exact: true }),
  ).toBeVisible();
}
/** The heartbeat is silent; a refresh on demand lives in search (⌘K). */
export async function refreshNow(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('combobox', { name: /搜索/ });
  await search.fill('立即刷新');
  await search.press('Enter');
}
/** A new channel is named in place; Enter creates it, and it is opened. */
export async function createChannel(page: Page, name: string) {
  await page.getByRole('button', { name: '新建频道' }).click();
  await page.getByLabel('频道名称').fill(name);
  await page.getByLabel('频道名称').press('Enter');
  await expect(
    page.getByRole('heading', { name: '# ' + name, exact: true }),
  ).toBeVisible();
}
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * An agent's tile on the Team gallery; it opens the agent's page. Its name
 * and presence are separate spans, which Chromium may join without a space.
 */
export function agentRow(page: Page, name: string) {
  return page
    .getByRole('list', { name: '团队', exact: true })
    .getByRole('button', {
      name: new RegExp('^' + literal(name) + '\\s*(在线|离线)$'),
    });
}
/** Registered from a channel, an agent joins it, and its page opens. */
export async function register(page: Page, name: string, role: string) {
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  // The last tile adds an agent (the sidebar's own "添加智能体" is outside the
  // gallery).
  await page
    .getByRole('list', { name: '团队', exact: true })
    .getByRole('button', { name: '添加智能体', exact: true })
    .click();
  const form = page.getByRole('form', { name: '智能体资料' });
  await form.getByLabel('智能体名称').fill(name);
  await form.getByLabel('角色', { exact: true }).selectOption(role);
  await form.getByRole('button', { name: '添加智能体', exact: true }).click();
  const agent = page.getByRole('region', { name, exact: true });
  await expect(agent).toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: `把 ${name} 加入频道` }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(agent).toHaveCount(0);
}
/** An agent's own page, opened from its tile; any tab leaves it. */
export async function openAgent(page: Page, name: string) {
  await page.getByRole('tab', { name: '成员', exact: true }).click();
  await agentRow(page, name).click();
  const agent = page.getByRole('region', { name, exact: true });
  await expect(agent).toBeVisible();
  return agent;
}
/** The worker reports in on its own; the hub pushes it to the page. */
export async function untilReady(page: Page, timeout = 20000) {
  await expect(
    page
      .getByRole('region', { name: '配置', exact: true })
      .getByText('可以回复了'),
  ).toBeVisible({ timeout });
}
export interface TaskFields {
  title: string;
  description?: string;
  /** One condition per row of "Done when". */
  criteria: string[];
  /** Option values: 'agent:<id>' or 'human:<id>'. */
  owner?: string;
  reviewer?: string;
}
/** A task's page, in place of the board. */
export function taskPage(page: Page, title: string) {
  return page.getByRole('region', { name: title, exact: true });
}
/** A new task is written on its own page; created, it stays on screen as itself. */
export async function newTask(page: Page, fields: TaskFields) {
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await page.getByRole('button', { name: '新任务' }).click();
  const form = page.getByRole('form', { name: '新任务' });
  await form.getByLabel('任务标题').fill(fields.title);
  if (fields.description !== undefined)
    await form.getByLabel('描述', { exact: true }).fill(fields.description);
  // Enter in a row starts the next one.
  const row = (index: number) =>
    form.getByLabel(
      index === 0 ? '完成标准' : `完成标准 ${String(index + 1)}`,
      { exact: true },
    );
  for (const [index, criterion] of fields.criteria.entries()) {
    if (index > 0) await row(index - 1).press('Enter');
    await row(index).fill(criterion);
  }
  if (fields.owner !== undefined)
    await form.getByLabel('负责人', { exact: true }).selectOption(fields.owner);
  if (fields.reviewer !== undefined)
    await form
      .getByLabel('审核人', { exact: true })
      .selectOption(fields.reviewer);
  await form.getByRole('button', { name: '创建任务', exact: true }).click();
  const task = taskPage(page, fields.title);
  await expect(task).toBeVisible();
  return task;
}
/** Board columns are the five stages; a card's column is its status. */
export function inStage(page: Page, stage: string, title: string) {
  return page
    .getByRole('region', { name: stage, exact: true })
    .getByRole('article', { name: title, exact: true });
}
/** A card opens its task's page in place of the board. */
export async function openTask(page: Page, title: string) {
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await page
    .getByRole('article', { name: title, exact: true })
    .getByRole('button', { name: title, exact: true })
    .click();
  const task = taskPage(page, title);
  await expect(task).toBeVisible();
  return task;
}
/** Esc leaves a task's page for the board. */
export async function backToBoard(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '任务看板' })).toBeVisible();
}
