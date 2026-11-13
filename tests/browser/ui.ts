import { expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

/**
 * The workspace as a person drives it. The CI browser suite and the paid
 * live driver (tests/live/hub.ts) share these, so a renamed control fails
 * in CI before it can break a live run.
 */
export interface Owner {
  username: string;
  password: string;
  team: string;
}
export async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '# general', exact: true }),
  ).toBeVisible();
}
/** First-owner setup, then sign in; ends in #general. Returns the password. */
export async function onboard(
  page: Page,
  hub: { origin: string; setup: string },
  owner: Partial<Owner> = {},
) {
  const username = owner.username ?? 'browser_owner';
  const password = owner.password ?? randomBytes(24).toString('base64url');
  await page.goto(hub.origin);
  await page.getByRole('tab', { name: 'First owner setup' }).click();
  await page.getByLabel('Setup secret', { exact: true }).fill(hub.setup);
  await page.getByLabel('Owner username', { exact: true }).fill(username);
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page
    .getByLabel('Team name', { exact: true })
    .fill(owner.team ?? 'Fieldnotes team');
  await page.getByRole('button', { name: 'Create owner and team' }).click();
  await expect(
    page.getByText('Owner created. Sign in with your new credentials.'),
  ).toBeVisible();
  await signIn(page, username, password);
  return password;
}
/** The heartbeat is silent; a refresh on demand lives in the command palette. */
export async function refreshNow(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('combobox', { name: /Search/ });
  await search.fill('refresh now');
  await search.press('Enter');
}
/** A new channel is named in place; Enter creates it, and it is opened. */
export async function createChannel(page: Page, name: string) {
  await page.getByRole('button', { name: 'New channel' }).click();
  await page.getByLabel('Channel name').fill(name);
  await page.getByLabel('Channel name').press('Enter');
  await page
    .getByRole('navigation', { name: 'Channels' })
    .getByRole('button', { name, exact: true })
    .click();
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
    .getByRole('list', { name: 'Team', exact: true })
    .getByRole('button', {
      name: new RegExp('^' + literal(name) + '\\s*(Online|Offline)$'),
    });
}
/** Registered from a channel, an agent joins it, and its page opens. */
export async function register(page: Page, name: string, role: string) {
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Register agent' }).click();
  const form = page.getByRole('form', { name: 'Agent profile' });
  await form.getByLabel('Agent name').fill(name);
  await form.getByLabel('Role', { exact: true }).selectOption(role);
  await form
    .getByRole('button', { name: 'Register agent', exact: true })
    .click();
  const agent = page.getByRole('region', { name, exact: true });
  await expect(agent).toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Add ${name} to channel` }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(agent).toHaveCount(0);
}
/** An agent's own page, opened from its tile; any tab leaves it. */
export async function openAgent(page: Page, name: string) {
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await agentRow(page, name).click();
  const agent = page.getByRole('region', { name, exact: true });
  await expect(agent).toBeVisible();
  return agent;
}
/** The worker reports in on its own; refresh until the page says so. */
export async function untilReady(page: Page, timeout = 20000) {
  const setup = page.getByRole('region', { name: 'Setup', exact: true });
  // Each refresh costs the hub several requests; asking every few seconds
  // stays well under its per-minute limit while a real worker starts.
  await expect(async () => {
    await refreshNow(page);
    await expect(setup.getByText('Ready to answer')).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout, intervals: [2000, 5000] });
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
  await page.getByRole('tab', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task title').fill(fields.title);
  if (fields.description !== undefined)
    await form
      .getByLabel('Description', { exact: true })
      .fill(fields.description);
  // Enter in a row starts the next one.
  const row = (index: number) =>
    form.getByLabel(
      index === 0 ? 'Done when' : `Done when ${String(index + 1)}`,
      { exact: true },
    );
  for (const [index, criterion] of fields.criteria.entries()) {
    if (index > 0) await row(index - 1).press('Enter');
    await row(index).fill(criterion);
  }
  if (fields.owner !== undefined)
    await form.getByLabel('Owner', { exact: true }).selectOption(fields.owner);
  if (fields.reviewer !== undefined)
    await form
      .getByLabel('Reviewer', { exact: true })
      .selectOption(fields.reviewer);
  await form.getByRole('button', { name: 'Create task', exact: true }).click();
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
  await page.getByRole('tab', { name: 'Board', exact: true }).click();
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
  await expect(page.getByRole('region', { name: 'Task board' })).toBeVisible();
}
