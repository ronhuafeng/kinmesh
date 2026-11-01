import type { Page, APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Agent, Grant } from '../../src/domain/agents.js';
import { Task, TaskResult } from '../../src/domain/tasks.js';
import { pageOf } from '../../src/domain/communication.js';
import { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { test, expect } from './fixture.js';
async function onboard(page: Page, hub: { origin: string; setup: string }) {
  await page.goto(hub.origin);
  await page.getByRole('tab', { name: 'First owner setup' }).click();
  await page.getByLabel('Setup secret', { exact: true }).fill(hub.setup);
  await page
    .getByLabel('Owner username', { exact: true })
    .fill('browser_owner');
  const password = randomBytes(24).toString('base64url');
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page.getByLabel('Team name', { exact: true }).fill('Fieldnotes team');
  await page.getByRole('button', { name: 'Create owner and team' }).click();
  await expect(
    page.getByText('Owner created. Sign in with your new credentials.'),
  ).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('browser_owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  return password;
}
async function snapshot(request: APIRequestContext, origin: string) {
  const response = await request.get(origin + '/api/workspace');
  expect(response.status()).toBe(200);
  return WorkspaceSnapshot.parse(await response.json());
}
/** The heartbeat is silent; a refresh on demand lives in the command palette. */
async function refreshNow(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('combobox', { name: /Search/ });
  await search.fill('refresh now');
  await search.press('Enter');
}
/** Healthy means no connection pill at all. */
async function expectHealthy(page: Page) {
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /^(Refreshing…|Disconnected)$/ }),
  ).toHaveCount(0);
}
/** Run and thread IDs sit behind each run's technical details. */
async function showTechnical(page: Page) {
  const details = page.locator('.execution details.technical');
  await expect(details.first()).toBeAttached();
  await details.evaluateAll((all) => {
    for (const element of all)
      if (element instanceof HTMLDetailsElement) element.open = true;
  });
}
/** How a recorded runtime state is said to a person. */
const spoken: Record<string, string> = {
  unknown: 'unknown',
  active: 'working',
  waiting: 'waiting',
  succeeded: 'finished',
  failed: 'failed',
  stopped: 'stopped',
};
/** Board columns are the five stages; a card's column is its status. */
function inStage(page: Page, stage: string, title: string) {
  return page
    .getByRole('region', { name: stage, exact: true })
    .getByRole('article', { name: title, exact: true });
}
async function register(page: Page, name: string, role: string) {
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await page.getByText('Register agent', { exact: true }).first().click();
  const form = page.getByRole('form', { name: 'Agent profile' });
  await form.getByLabel('Agent name').fill(name);
  await form.getByLabel('Role', { exact: true }).selectOption(role);
  await form
    .getByRole('button', { name: 'Register agent', exact: true })
    .click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Add ${name} to channel` }).click();
  await expect(page.getByText('Joined this channel')).toHaveCount(1);
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
for (const width of [1440, 375]) {
  test(`real workspace onboarding, history, mentions and reconnect at ${String(width)}px`, async ({
    page,
    context,
    hub,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await onboard(page, hub);
    await page.getByText('New channel', { exact: true }).click();
    const create = page.getByRole('form', { name: 'Create a channel' });
    await create.getByLabel('Channel name').fill('design');
    await create
      .getByRole('button', { name: 'Create channel', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Channels' })
      .getByRole('button', { name: 'design', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '# design', exact: true }),
    ).toBeVisible();
    await register(page, 'Ada', 'developer');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByText('Start a topic', { exact: true }).click();
    await page.getByLabel('Topic title').fill('Release planning');
    await page
      .getByRole('button', { name: 'Create topic', exact: true })
      .click();
    const topics = page.getByRole('group', { name: 'Topics' });
    await topics
      .getByRole('button', { name: 'Release planning', exact: true })
      .click();
    await expect(
      topics.getByRole('button', { name: 'Release planning', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const composer = page.getByRole('form', { name: 'Message your team' });
    const text =
      '<img src=x onerror="window.__injected=true"> Persistent hello';
    const sent = text + ' @Ada';
    const message = composer.getByLabel('Message', { exact: true });
    await message.fill(text);
    await message.pressSequentially(' @Ad');
    await page
      .getByRole('listbox', { name: 'Mention suggestions' })
      .getByRole('option', { name: /Ada/ })
      .click();
    await expect(
      composer.getByRole('list', { name: 'Mentions' }).getByText('@Ada'),
    ).toBeVisible();
    await composer.getByRole('button', { name: 'Send message' }).click();
    await expect(
      page
        .getByRole('list', { name: 'Channel messages' })
        .getByText(sent, { exact: true }),
    ).toBeVisible();
    // The mention reads in the text itself; no second @Ada chip repeats it,
    // and it still reaches Ada (its delivery line is shown).
    const posted = page
      .getByRole('list', { name: 'Channel messages' })
      .getByRole('listitem')
      .filter({ hasText: sent });
    await expect(posted.getByRole('list', { name: 'Mentioned' })).toHaveCount(
      0,
    );
    await expect(
      posted.getByRole('list', { name: 'Agent responses' }),
    ).toContainText('Ada');
    await page.reload();
    await expect(page.getByText(sent, { exact: true })).toBeVisible();
    expect(await page.locator('.messages img').count()).toBe(0);
    // Healthy is silent; the pill and its Reconnect button appear only offline.
    await expectHealthy(page);
    await context.setOffline(true);
    await refreshNow(page);
    await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
    // Reconnecting while still offline keeps the honest state.
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
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
    await page.screenshot({
      path: `artifacts/workspace-${String(width)}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Welcome back' }),
    ).toBeVisible();
  });
}
test('two independent task cards: real agent handoff, human review, acceptance and rework', async ({
  page,
  context,
  playwright,
  hub,
}) => {
  await onboard(page, hub);
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
    await page.getByRole('tab', { name: 'Board', exact: true }).click();
    await page
      .locator('summary')
      .filter({ hasText: /^Create task$/ })
      .click();
    const form = page.getByRole('form', { name: 'New task' });
    for (const title of ['Ship alpha', 'Ship beta']) {
      await form.getByLabel('Task title').fill(title);
      await form
        .getByLabel('Description', { exact: true })
        .fill('Browser responsibility test');
      await form
        .getByLabel('Acceptance criteria (one per line)')
        .fill('Reviewed and human accepted');
      await form
        .getByLabel('Owner', { exact: true })
        .selectOption('agent:' + developer.id);
      await form
        .getByLabel('Reviewer', { exact: true })
        .selectOption('human:' + state.human.id);
      await form
        .getByRole('button', { name: 'Create task', exact: true })
        .click();
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
    await refreshNow(page);
    const alpha = page.getByRole('article', {
      name: 'Ship alpha',
      exact: true,
    });
    const beta = page.getByRole('article', { name: 'Ship beta', exact: true });
    // Each task opens in its own drawer; decisions are explicit buttons.
    const alphaDrawer = page.getByRole('region', {
      name: 'Ship alpha',
      exact: true,
    });
    const betaDrawer = page.getByRole('region', {
      name: 'Ship beta',
      exact: true,
    });
    await expect(inStage(page, 'Review', 'Ship alpha')).toBeVisible();
    await alpha.getByRole('button', { name: 'Ship alpha' }).click();
    await alphaDrawer
      .getByLabel('Decision note')
      .fill('Technical review complete');
    await alphaDrawer
      .getByRole('button', { name: 'Approve review', exact: true })
      .click();
    await expect(inStage(page, 'Human sign-off', 'Ship alpha')).toBeVisible();
    await expect(inStage(page, 'Review', 'Ship beta')).toBeVisible();
    await alphaDrawer
      .getByLabel('Decision note')
      .fill('I accept the alpha outcome');
    await alphaDrawer
      .getByRole('button', { name: 'Accept task', exact: true })
      .click();
    await expect(inStage(page, 'Done', 'Ship alpha')).toBeVisible();
    await beta.getByRole('button', { name: 'Ship beta' }).click();
    await expect(alphaDrawer).toHaveCount(0);
    await betaDrawer.getByLabel('Decision note').fill('Beta needs more work');
    await betaDrawer
      .getByRole('button', { name: 'Request rework', exact: true })
      .click();
    // Sent back is still Working, and the card says so in words.
    await expect(inStage(page, 'Working', 'Ship beta')).toBeVisible();
    await expect(beta.getByText('Sent back', { exact: true })).toBeVisible();
    await expect(inStage(page, 'Done', 'Ship alpha')).toBeVisible();
    await page.screenshot({
      path: 'artifacts/workspace-tasks.png',
      fullPage: true,
    });
    await alpha.getByRole('button', { name: 'Ship alpha' }).click();
    await expect(
      alphaDrawer.getByRole('heading', { name: 'History' }),
    ).toBeVisible();
    // History records the acceptance with its note, as a sentence.
    await expect(
      alphaDrawer.getByText('You accepted it: “I accept the alpha outcome”', {
        exact: true,
      }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(alphaDrawer).toHaveCount(0);
    await page.reload();
    await page.getByRole('tab', { name: 'Board', exact: true }).click();
    await expect(inStage(page, 'Done', 'Ship alpha')).toBeVisible();
    await expect(inStage(page, 'Working', 'Ship beta')).toBeVisible();
  } finally {
    await agent.dispose();
  }
});
test('AG-UI snapshots render persisted reports honestly; identity spoofing and cross-team reads denied', async ({
  page,
  context,
  playwright,
  hub,
}) => {
  await onboard(page, hub);
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
  await page.getByRole('button', { name: 'View Observer activity' }).click();
  await expect(
    page.getByText('Last reported: waiting', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Last reported: waiting')).toBeVisible();
  await showTechnical(page);
  await expect(
    page.getByText('browser-fixture-thread', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open in T3 (no verified link)' }),
  ).toBeDisabled();
  const nativeResponse = page.waitForResponse((response) =>
    response.url().endsWith('/executions/' + correlation.id + '/native'),
  );
  await page.getByRole('button', { name: 'Check in T3' }).click();
  expect((await nativeResponse).status()).toBe(503);
  await expect(page.getByText(/T3 can’t be checked right now/)).toBeVisible();
  await expect(page.getByText(/T3 confirms/)).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Open in T3', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('Last reported: waiting')).toBeVisible();
  expect((await context.request.get(hub.origin + '/api/me')).status()).toBe(
    200,
  );
  for (const status of ['failed', 'stopped', 'succeeded']) {
    expect(
      (
        await context.request.post(
          base + '/executions/' + correlation.id + '/events',
          { data: { state: status } },
        )
      ).status(),
    ).toBe(201);
    await refreshNow(page);
    await expect(
      page.getByText('Last reported: ' + (spoken[status] ?? status)),
    ).toBeVisible();
  }
  const anon = await playwright.request.newContext();
  try {
    expect((await anon.get(hub.origin + '/api/workspace')).status()).toBe(401);
    expect(
      (
        await anon.get(`${hub.origin}/api/agui/${state.team.id}/${agent.id}`)
      ).status(),
    ).toBe(401);
    expect(
      (
        await anon.get(hub.origin + '/api/workspace', {
          headers: { 'x-kinmesh-actor': state.human.id },
        })
      ).status(),
    ).toBe(400);
    expect(
      (await anon.get(hub.origin + '/api/workspace?actor=owner')).status(),
    ).toBe(400);
    expect(
      (
        await context.request.get(
          `${hub.origin}/api/agui/${randomUUID()}/${agent.id}`,
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await context.request.post(hub.origin + '/api/logout', {
          headers: { origin: 'https://untrusted.invalid' },
        })
      ).status(),
    ).toBe(403);
    expect(
      (await anon.get(hub.origin + '/assets/../../.env')).status(),
    ).not.toBe(200);
  } finally {
    await anon.dispose();
  }
});

test('keyboard mention, message becomes a task in its topic, and the needs-me filter', async ({
  page,
  context,
  hub,
}) => {
  await onboard(page, hub);
  await register(page, 'Ada', 'developer');
  // A profile alone cannot be woken; the roster says so before anyone waits.
  const adaRow = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Ada', exact: true }) });
  await expect(
    adaRow.getByText('Not connected', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/No agent can be woken yet/)).toBeVisible();
  const profile = (await snapshot(context.request, hub.origin)).agents[0];
  if (!profile) throw new Error('Local fixture unavailable');
  const worker = new Database(hub.database);
  try {
    // Test boundary: what an Inbox worker writes on each loop.
    worker
      .prepare(
        'INSERT INTO inbox_bindings (agent_id, team_id, last_seen_at) VALUES (?, ?, ?)',
      )
      .run(profile.id, profile.teamId, Date.now());
  } finally {
    worker.close();
  }
  await refreshNow(page);
  await expect(adaRow.getByText('Can be woken', { exact: true })).toBeVisible();
  await expect(page.getByText(/No agent can be woken yet/)).toHaveCount(0);
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByText('Start a topic', { exact: true }).click();
  await page.getByLabel('Topic title').fill('Billing');
  await page.getByRole('button', { name: 'Create topic', exact: true }).click();
  await page
    .getByRole('group', { name: 'Topics' })
    .getByRole('button', { name: 'Billing', exact: true })
    .click();
  // No wait for the topic refresh: typing must survive a background reload.
  const composer = page.getByRole('form', { name: 'Message your team' });
  const message = composer.getByLabel('Message', { exact: true });
  await message.fill('Validate postal codes per country');
  await message.pressSequentially(' @a');
  await expect(message).toHaveValue('Validate postal codes per country @a');
  await expect(
    page.getByRole('option', { name: /Ada/, selected: true }),
  ).toBeVisible();
  await message.press('Enter');
  await expect(message).toHaveValue('Validate postal codes per country @Ada ');
  await expect(
    composer.getByRole('list', { name: 'Mentions' }).getByText('@Ada'),
  ).toBeVisible();
  // Sent while the topic switch may still be refreshing: it must go through.
  await message.press('ControlOrMeta+Enter');
  const posted = page
    .getByRole('list', { name: 'Channel messages' })
    .getByRole('listitem')
    .filter({ hasText: 'Validate postal codes per country @Ada' });
  await expect(posted).toBeVisible();
  await posted.getByRole('button', { name: 'Make task', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: 'Board', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const form = page.getByRole('form', { name: 'New task' });
  await expect(form.getByLabel('Task title')).toHaveValue(
    'Validate postal codes per country @Ada',
  );
  await expect(
    page.getByText('From a message by browser_owner.', { exact: false }),
  ).toBeVisible();
  await form
    .getByLabel('Acceptance criteria (one per line)')
    .fill('Postal codes validated per country');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada || !state.channel) throw new Error('Local fixture unavailable');
  await form
    .getByLabel('Owner', { exact: true })
    .selectOption('agent:' + ada.id);
  await form.getByRole('button', { name: 'Create task', exact: true }).click();
  const card = page.getByRole('article', {
    name: 'Validate postal codes per country @Ada',
  });
  await expect(
    inStage(page, 'Working', 'Validate postal codes per country @Ada'),
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
  const filter = page.getByRole('group', { name: 'Task filter' });
  await filter.getByRole('button', { name: 'Needs me', exact: true }).click();
  await expect(card).toHaveCount(0);
  await filter.getByRole('button', { name: 'Mine', exact: true }).click();
  await expect(card).toBeVisible();
  await filter.getByRole('button', { name: 'All', exact: true }).click();
  await expect(card).toBeVisible();
  // ⌘K jumps straight to the task; only its acceptor may cancel it, with a note.
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette
    .getByRole('combobox', { name: /Search/ })
    .fill('postal in progress');
  await expect(
    palette.getByRole('option', { name: /Validate postal codes/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  const drawer = page.getByRole('region', {
    name: 'Validate postal codes per country @Ada',
  });
  await expect(drawer).toBeVisible();
  await drawer
    .getByRole('button', { name: 'Cancel task…', exact: true })
    .click();
  await expect(
    drawer.getByText(/closes the task without acceptance/),
  ).toBeVisible();
  await drawer.getByLabel('Decision note').fill('Superseded by the new form');
  await drawer
    .getByRole('button', { name: 'Cancel task', exact: true })
    .click();
  // Cancelled work leaves the board quietly; it is one click away in Done.
  await expect(drawer.getByText('This task is closed.')).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show cancelled (1)' }).click();
  await expect(
    inStage(page, 'Done', 'Validate postal codes per country @Ada').getByText(
      'Cancelled',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Task cancelled.' }),
  ).toBeVisible();
});

test('a mention says what happened to it and leads to the agent’s reply', async ({
  page,
  context,
  playwright,
  hub,
}) => {
  await onboard(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada || !state.channel) throw new Error('Local fixture unavailable');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const composer = page.getByRole('form', { name: 'Message your team' });
  await composer
    .getByLabel('Message', { exact: true })
    .fill('@Ada please check the release notes');
  await composer.getByRole('button', { name: 'Send message' }).click();
  const asked = page
    .getByRole('list', { name: 'Channel messages' })
    .getByRole('listitem')
    .filter({ hasText: 'please check the release notes' })
    .first();
  const responses = asked.getByRole('list', { name: 'Agent responses' });
  // No worker yet: the person learns it now, not after a week of silence.
  await expect(responses).toContainText('Ada isn’t connected');
  const sql = new Database(hub.database);
  try {
    sql
      .prepare(
        'INSERT INTO inbox_bindings (agent_id, team_id, last_seen_at) VALUES (?, ?, ?)',
      )
      .run(ada.id, ada.teamId, Date.now());
  } finally {
    sql.close();
  }
  await refreshNow(page);
  await expect(responses).toContainText('Ada will pick this up');
  // Simulate what the worker does on success: the agent replies and the
  // delivery is acknowledged with that reply.
  const source = (await snapshot(context.request, hub.origin)).messages
    .items[0];
  if (!source) throw new Error('Mention not persisted');
  const token = await agentGrant(
    context.request,
    hub.origin,
    state.team.id,
    ada.id,
  );
  const agent = await playwright.request.newContext({
    extraHTTPHeaders: { authorization: 'Bearer ' + token },
  });
  try {
    const posted = await agent.post(
      `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/messages`,
      {
        data: {
          operationKey: randomUUID(),
          body: 'Release notes checked; two links were broken and are fixed.',
          topicId: null,
          mentions: [],
          sourceMessageId: source.id,
          sourceEventId: null,
        },
      },
    );
    expect(posted.status()).toBe(201);
    const reply = z.object({ id: z.uuid() }).parse(await posted.json());
    const db = new Database(hub.database);
    try {
      db.prepare(
        "UPDATE agent_inbox SET state = 'acked', reason = 'assistant-result-published', result_message_id = ? WHERE message_id = ?",
      ).run(reply.id, source.id);
    } finally {
      db.close();
    }
  } finally {
    await agent.dispose();
  }
  await refreshNow(page);
  await responses.getByRole('button', { name: /Ada replied/ }).click();
  const answer = page
    .getByRole('list', { name: 'Channel messages' })
    .getByRole('listitem')
    .filter({ hasText: 'two links were broken' });
  await expect(answer).toBeInViewport();
  await expect(
    answer.getByRole('button', { name: /In reply to browser_owner/ }),
  ).toBeVisible();
});

test('Needs you gathers what waits on me across channels and leads to the fix', async ({
  page,
  hub,
}) => {
  await onboard(page, hub);
  await register(page, 'Ada', 'developer');
  await page.keyboard.press('Escape');
  const needs = page.getByRole('button', { name: /^Needs you/ });
  await expect(needs).toHaveText(/0$/);
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const composer = page.getByRole('form', { name: 'Message your team' });
  await composer
    .getByLabel('Message', { exact: true })
    .fill('@Ada please check the release notes');
  await composer.getByRole('button', { name: 'Send message' }).click();
  // Ada has no worker: queued work shows up as something to connect.
  await expect(needs).toHaveText(/1$/);
  await page.getByText('New channel', { exact: true }).click();
  await page.getByLabel('Channel name').fill('launch');
  await page
    .getByRole('button', { name: 'Create channel', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Channels' })
    .getByRole('button', { name: 'launch' })
    .click();
  await expect(page.getByRole('heading', { name: '# launch' })).toBeVisible();
  await expect(needs).toHaveText(/1$/);
  await needs.click();
  const drawer = page.getByRole('region', { name: 'Needs you' });
  await drawer
    .getByRole('button', {
      name: /Ada has 1 request waiting but can’t be woken yet/,
    })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Ada', exact: true })
      .getByRole('group', { name: 'Connect T3' }),
  ).toBeVisible();
  // A blocking failure turns it into something to unstick, wherever I am.
  const sql = new Database(hub.database);
  try {
    sql
      .prepare(
        "UPDATE agent_inbox SET state = 'blocked', reason = 'authority-or-contract-blocked'",
      )
      .run();
  } finally {
    sql.close();
  }
  await refreshNow(page);
  await page.keyboard.press('Escape');
  await needs.click();
  await expect(drawer.getByRole('region', { name: 'Connect' })).toHaveCount(0);
  await drawer
    .getByRole('region', { name: 'Unstuck' })
    .getByRole('button', { name: /Ada is stuck/ })
    .click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(
    page
      .getByRole('list', { name: 'Channel messages' })
      .getByText('please check the release notes'),
  ).toBeVisible();
});

test('a stuck request says what was lost and is fixed and retried in place', async ({
  page,
  context,
  hub,
}) => {
  await onboard(page, hub);
  await register(page, 'Ada', 'developer');
  await page.keyboard.press('Escape');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada || !state.channel) throw new Error('Local fixture unavailable');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  const composer = page.getByRole('form', { name: 'Message your team' });
  await composer
    .getByLabel('Message', { exact: true })
    .fill('@Ada please check the release notes');
  await composer.getByRole('button', { name: 'Send message' }).click();
  const responses = page
    .getByRole('list', { name: 'Channel messages' })
    .getByRole('listitem')
    .filter({ hasText: 'please check the release notes' })
    .first()
    .getByRole('list', { name: 'Agent responses' });
  await expect(responses).toContainText('Ada isn’t connected');
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
  const sql = new Database(hub.database);
  try {
    sql
      .prepare(
        "UPDATE agent_inbox SET state = 'blocked', reason = 'not-in-channel'",
      )
      .run();
  } finally {
    sql.close();
  }
  await refreshNow(page);
  await expect(responses).toContainText(
    'Ada was removed from the channel, so this is on hold',
  );
  await expect(responses.getByText(/npm run/)).toHaveCount(0);
  await responses
    .getByRole('button', { name: 'Add Ada back and retry', exact: true })
    .click();
  // Back in the channel and retried with the original request.
  await expect(responses).toContainText('Checking whether Ada’s run started');
  const after = await snapshot(context.request, hub.origin);
  expect(after.joinedAgentIds).toContain(ada.id);
  expect(after.deliveries[0]?.state).toBe('uncertain');
  expect(after.deliveries[0]?.reason).toBe('owner-resume');
  // A cause fixed elsewhere leads there and offers a plain retry.
  const db = new Database(hub.database);
  try {
    db.prepare(
      "UPDATE agent_inbox SET state = 'blocked', reason = 'credential-invalid'",
    ).run();
  } finally {
    db.close();
  }
  await refreshNow(page);
  await expect(responses).toContainText('Ada’s credential was revoked');
  await expect(
    responses.getByRole('button', { name: 'Retry', exact: true }),
  ).toBeVisible();
  await responses
    .getByRole('button', { name: 'Fix Ada’s setup', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Ada', exact: true })
      .getByRole('button', { name: 'Connect T3', exact: true }),
  ).toBeVisible();
});

test('connect T3 and an agent in two clicks: the hub keeps the credential and wakes the agent', async ({
  page,
  context,
  hub,
}) => {
  await onboard(page, hub);
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
              }
            : null,
        signIn: t3 === 'waiting' ? 'waiting' : null,
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
  await page.route('**/api/teams/*/t3/providers', (route) =>
    route.fulfill({
      json: {
        providers: [
          { id: 'cursor', models: [] },
          { id: 'isolated-ada', models: ['model-x'] },
        ],
      },
    }),
  );
  await page.getByRole('button', { name: 'View Ada activity' }).click();
  const setup = page
    .getByRole('region', { name: 'Ada', exact: true })
    .getByRole('region', { name: 'Setup' });
  // T3 on this Mac is found: no URL to look up, one button.
  const connectT3 = setup.getByRole('group', { name: 'Connect T3' });
  await expect(connectT3).toContainText('T3 is running on this Mac');
  await expect(connectT3.getByLabel('T3 MCP URL')).toHaveCount(0);
  await connectT3
    .getByRole('button', { name: 'Connect T3', exact: true })
    .click();
  await expect(
    connectT3.getByRole('link', { name: 'Approve in T3 ↗' }),
  ).toHaveAttribute('href', 'http://127.0.0.1:3773/authorize?state=x');
  await expect(connectT3).toContainText('pairing code');
  await expect(connectT3).toContainText('Supervised');
  // Approved read-only by mistake: said plainly, before anyone waits.
  t3 = 'read';
  const permission = setup.getByRole('group', {
    name: 'Give T3 permission to run',
  });
  await expect(permission).toContainText('choose Supervised');
  await permission
    .getByRole('button', { name: 'Connect T3', exact: true })
    .click();
  // Approved with Supervised; the hub records the connection.
  const sql = new Database(hub.database);
  try {
    sql
      .prepare(
        'INSERT INTO t3_connections (team_id, endpoint, environment_id, connected_at) VALUES (?, ?, ?, ?)',
      )
      .run(state.team.id, 'http://127.0.0.1:3773/mcp', 'env-live', Date.now());
  } finally {
    sql.close();
  }
  t3 = 'operate';
  // One choice: the model, grouped by provider; providers without models are left out.
  const choose = setup.getByRole('form', { name: 'Choose what Ada runs on' });
  await expect(choose.getByLabel('Model')).toHaveValue('isolated-ada\nmodel-x');
  await expect(choose.locator('optgroup')).toHaveCount(1);
  await choose.getByRole('button', { name: 'Connect Ada' }).click();
  // The hub started its own worker for Ada; no file was edited.
  await expect(async () => {
    await refreshNow(page);
    await expect(setup.getByText('Ada is ready')).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 20000 });
  await expect(setup).toContainText('Runs on isolated-ada · model-x');
  const tokenFile = join(
    dirname(hub.database),
    'managed',
    'agents',
    ada.id + '.json',
  );
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  const { token } = z
    .object({ token: z.string() })
    .parse(JSON.parse(readFileSync(tokenFile, 'utf8')));
  expect(await page.content()).not.toContain(token);
  const after = await snapshot(context.request, hub.origin);
  expect(after.agents[0]?.preferences).toEqual({
    environmentId: 'env-live',
    providerId: 'isolated-ada',
    modelId: 'model-x',
  });
});

test('the agent panel still walks an operator through a self-run worker binding', async ({
  page,
  context,
  hub,
}) => {
  await onboard(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada) throw new Error('Local fixture unavailable');
  await page.getByRole('button', { name: 'View Ada activity' }).click();
  const setup = page
    .getByRole('region', { name: 'Ada', exact: true })
    .getByRole('region', { name: 'Setup' });
  const step = (title: string) =>
    setup.getByRole('listitem').filter({ hasText: title });
  // Running the worker by hand stays available under More.
  await setup.getByText('More', { exact: true }).click();
  await setup.getByText('Run the worker yourself', { exact: true }).click();
  await expect(step('Runtime preferences')).toContainText('(to do)');
  await setup.getByLabel('T3 environment ID').fill('env-primary');
  await setup.getByLabel('Isolated provider ID').fill('isolated-ada');
  await setup.getByLabel('Model ID').fill('model-x');
  await setup.getByRole('button', { name: 'Save preferences' }).click();
  await expect(step('Runtime preferences')).toContainText(
    'env-primary · isolated-ada/model-x',
  );
  await expect(step('Runtime preferences')).toContainText('(done)');
  await setup
    .getByRole('button', { name: 'Issue worker credential', exact: true })
    .click();
  const shown = step('Worker credential').locator('.token-once code.reference');
  await expect(shown).toHaveText(/^kma_/);
  const token = await shown.innerText();
  await expect(step('Worker credential')).toContainText('(done)');
  // The credential is shown once: neither the API nor the page can repeat it.
  await setup.getByRole('button', { name: 'I saved it' }).click();
  await expect(shown).toHaveCount(0);
  const grantsUrl = `${hub.origin}/api/teams/${state.team.id}/agents/${ada.id}/grants`;
  const listed = await (await context.request.get(grantsUrl)).text();
  expect(listed).not.toContain(token);
  expect(listed).not.toContain('"token"');
  expect(await page.content()).not.toContain(token);
  const credentials = setup.getByRole('list', { name: 'Credentials' });
  await credentials.getByRole('button', { name: 'Rotate' }).click();
  await expect(shown).toHaveText(/^kma_/);
  await expect(shown).not.toHaveText(token);
  await setup.getByRole('button', { name: 'I saved it' }).click();
  await expect(credentials).toContainText('revoked');
  await credentials.getByRole('button', { name: 'Revoke' }).click();
  await expect(step('Worker credential')).toContainText('(to do)');
  await expect(
    setup.getByRole('button', { name: 'Issue worker credential' }),
  ).toBeVisible();
  // The binding is generated for this agent and carries no secret.
  const snippet = step('Inbox worker binding').locator('pre');
  await expect(snippet).toContainText(ada.id);
  await expect(snippet).toContainText('"isolatedProviderId": "isolated-ada"');
  await expect(snippet).not.toContainText('kma_');
});

test('lost message response retries the same committed operation; real conflict stays visible', async ({
  page,
  context,
  hub,
}) => {
  await onboard(page, hub);
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
  const composer = page.getByRole('form', { name: 'Message your team' });
  await composer
    .getByLabel('Message', { exact: true })
    .fill('One committed message, even after a lost response');
  await composer.getByRole('button', { name: 'Send message' }).click();
  await expect(
    composer.getByRole('button', { name: 'Retry same action' }),
  ).toBeVisible();
  await expect(composer.getByLabel('Message', { exact: true })).toBeDisabled();
  await composer.getByRole('button', { name: 'Retry same action' }).click();
  await expect(
    page.getByText('One committed message, even after a lost response', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(composer.getByLabel('Message', { exact: true })).toHaveValue('');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const after = await snapshot(context.request, hub.origin);
  expect(after.messages.items).toHaveLength(1);
  await register(page, 'Duplicate check', 'assistant');
  // Real server uniqueness conflict, not an intercepted/fabricated error response.
  const form = page.getByRole('form', { name: 'Agent profile' });
  await form.getByLabel('Agent name').fill('Duplicate check');
  await form
    .getByRole('button', { name: 'Register agent', exact: true })
    .click();
  await expect(form.getByRole('alert')).toContainText('HTTP 409');
});

test('human claim and request-review controls, plus leave/rejoin of known membership', async ({
  page,
  context,
  hub,
}) => {
  await onboard(page, hub);
  await register(page, 'Reviewer', 'reviewer');
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel || !state.agents[0])
    throw new Error('Local fixture unavailable');
  await page.getByRole('tab', { name: 'Board', exact: true }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^Create task$/ })
    .click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task title').fill('Human owned task');
  await form
    .getByLabel('Acceptance criteria (one per line)')
    .fill('Review requested with a recorded note');
  await form.getByRole('button', { name: 'Create task', exact: true }).click();
  const card = page.getByRole('article', { name: 'Human owned task' });
  const drawer = page.getByRole('region', { name: 'Human owned task' });
  await card.getByRole('button', { name: 'Human owned task' }).click();
  await drawer.getByRole('button', { name: 'Claim task', exact: true }).click();
  await expect(inStage(page, 'Working', 'Human owned task')).toBeVisible();
  await drawer
    .getByRole('button', { name: 'Request review…', exact: true })
    .click();
  await drawer
    .getByLabel('Recipient', { exact: true })
    .selectOption('agent:' + state.agents[0].id);
  await drawer.getByLabel('Decision note').fill('Please review the human work');
  await drawer
    .getByRole('button', { name: 'Request review', exact: true })
    .click();
  await expect(inStage(page, 'Review', 'Human owned task')).toBeVisible();
  await expect(
    drawer.getByRole('definition').filter({ hasText: /^Reviewer$/ }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByText('Channel details', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Leave channel', exact: true })
    .click();
  await expect(
    page.getByText('Welcome to your team', { exact: true }),
  ).toBeVisible();
  // A channel you left is offered back by name; no IDs to copy.
  await page.getByText('Rejoin a channel', { exact: true }).click();
  const left = page.getByRole('list', { name: 'Channels you left' });
  await expect(left.getByRole('listitem')).toHaveText([/general/]);
  await left.getByRole('button', { name: 'Rejoin', exact: true }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(page.getByText('You haven’t left any channels.')).toBeVisible();
  await page.getByRole('tab', { name: 'Board', exact: true }).click();
  await expect(inStage(page, 'Review', 'Human owned task')).toBeVisible();
});

test('a heartbeat refresh never interrupts work; after a failure nothing submits until a reconnect succeeds', async ({
  page,
  context,
  hub,
}) => {
  await onboard(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel unavailable');
  await page.getByText('New channel', { exact: true }).click();
  const create = page.getByRole('form', { name: 'Create a channel' });
  await create.getByLabel('Channel name').fill('after-reconnect');
  const composer = page.getByRole('form', { name: 'Message your team' });
  await composer
    .getByLabel('Message', { exact: true })
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
    for (const form of [create, composer]) {
      await expect(
        form.getByRole('button', { name: /Create channel|Send message/ }),
      ).toBeDisabled();
      // Bypass native disabled controls to verify the submit handler also fails closed.
      await form.evaluate((node) =>
        node.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
      );
    }
    await expect(
      page.getByRole('button', { name: 'Sign out', exact: true }),
    ).toBeDisabled();
    expect(posts).toBe(0);
  }
  // A: refreshing a confirmed snapshot changes nothing the person can do.
  const failRefresh = await holdWorkspace(503);
  await refreshNow(page);
  await expect(page.getByText('Refreshing…', { exact: true })).toBeVisible();
  await expect(composer.getByLabel('Message', { exact: true })).toBeEditable();
  await expect(
    composer.getByRole('button', { name: 'Send message' }),
  ).toBeEnabled();
  await expect(
    create.getByRole('button', { name: 'Create channel', exact: true }),
  ).toBeEnabled();
  // B: once a refresh fails, the snapshot is stale and every submission stops.
  failRefresh();
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
  // Typing goes on (nothing is lost); only sending waits for a confirmed snapshot.
  await expect(create.getByLabel('Channel name')).toBeEditable();
  await expect(composer.getByLabel('Message', { exact: true })).toBeEditable();
  await expectNothingSubmits();
  // B': a reconnect still in flight has not confirmed anything yet.
  const succeed = await holdWorkspace(200);
  await refreshNow(page);
  await expect(page.getByText('Refreshing…', { exact: true })).toBeVisible();
  await expect(create.getByLabel('Channel name')).toBeEditable();
  await expectNothingSubmits();
  await expect(
    composer.getByRole('alert').or(page.getByRole('alert')).first(),
  ).toBeVisible();
  // Only GET is broken: real server POST remains reachable to the authenticated owner.
  const probe = await context.request.post(
    `${hub.origin}/api/teams/${state.team.id}/channels`,
    { data: { name: 'reachable-post', operationKey: randomUUID() } },
  );
  expect(probe.status()).toBe(201);
  succeed();
  await expectHealthy(page);
  await page.unroute('**/api/workspace?*');
  await composer.getByRole('button', { name: 'Send message' }).click();
  await expect(
    page.getByText('Sent once the workspace is back', { exact: true }),
  ).toBeVisible();
  await expect(
    create.getByRole('button', { name: 'Create channel', exact: true }),
  ).toBeEnabled();
  await create
    .getByRole('button', { name: 'Create channel', exact: true })
    .click();
  await expect(
    page
      .getByRole('navigation', { name: 'Channels' })
      .getByRole('button', { name: 'after-reconnect', exact: true }),
  ).toBeVisible();
  expect(posts).toBe(2);
});

test('ambiguous login retry retains original request and login completion after switching to setup', async ({
  page,
  hub,
}) => {
  const password = await onboard(page, hub);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome back' }),
  ).toBeVisible();
  let attempts = 0;
  let original = '';
  let identical = false;
  let setupPosts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/setup'
    )
      setupPosts++;
  });
  await page.route('**/api/login', async (route) => {
    attempts++;
    const request = route.request();
    const serialized = JSON.stringify({
      url: request.url(),
      method: request.method(),
      body: request.postData(),
      headers: request.headers(),
    });
    if (attempts === 1) {
      original = serialized;
      await route.abort('timedout');
    } else {
      identical = serialized === original;
      await route.continue();
    }
  });
  await page.getByLabel('Username', { exact: true }).fill('browser_owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry same action' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'First owner setup' }).click();
  await expect(
    page.getByRole('button', { name: 'Create owner and team' }),
  ).toBeDisabled();
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: 'Retry same action' }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  expect(attempts).toBe(2);
  expect(identical).toBe(true);
  expect(setupPosts).toBe(0);
});

test('ambiguous setup retry retains setup completion after switching to login', async ({
  page,
  hub,
}) => {
  await page.goto(hub.origin);
  await page.getByRole('tab', { name: 'First owner setup' }).click();
  const password = randomBytes(24).toString('base64url');
  await page.getByLabel('Setup secret', { exact: true }).fill(hub.setup);
  await page.getByLabel('Owner username', { exact: true }).fill('retry_owner');
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page.getByLabel('Team name', { exact: true }).fill('Retry team');
  let attempts = 0;
  let original = '';
  let identical = false;
  let loginPosts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/login'
    )
      loginPosts++;
  });
  await page.route('**/api/setup', async (route) => {
    attempts++;
    const request = route.request();
    const serialized = JSON.stringify({
      body: request.postData(),
      headers: request.headers(),
      url: request.url(),
      method: request.method(),
    });
    if (attempts === 1) {
      original = serialized;
      await route.abort('timedout');
    } else {
      identical = serialized === original;
      await route.continue();
    }
  });
  await page.getByRole('button', { name: 'Create owner and team' }).click();
  await expect(
    page.getByRole('button', { name: 'Retry same action' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same action' }).click();
  await expect(
    page.getByText('Owner created. Sign in with your new credentials.'),
  ).toBeVisible();
  expect(attempts).toBe(2);
  expect(identical).toBe(true);
  expect(loginPosts).toBe(0);
  await page.getByLabel('Username', { exact: true }).fill('retry_owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
});

test('permission loss purges workspace snapshot instead of retaining stale team data', async ({
  page,
  context,
  hub,
}) => {
  await onboard(page, hub);
  const state = await snapshot(context.request, hub.origin);
  const privateMessage = 'Previously authorized channel message';
  const composer = page.getByRole('form', { name: 'Message your team' });
  await composer.getByLabel('Message', { exact: true }).fill(privateMessage);
  await composer.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(privateMessage, { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Board', exact: true }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^Create task$/ })
    .click();
  const taskForm = page.getByRole('form', { name: 'New task' });
  await taskForm.getByLabel('Task title').fill('Previously authorized task');
  await taskForm
    .getByLabel('Acceptance criteria (one per line)')
    .fill('Do not display after access is revoked');
  await taskForm.getByRole('button', { name: 'Create task' }).click();
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
  await expect(
    page.getByRole('heading', { name: 'Welcome back' }),
  ).toBeVisible();
  await expect(
    page.getByText(/HTTP 403: You are not authorized for this action/),
  ).toBeVisible();
  await expect(page.getByText(privateMessage, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: 'Previously authorized task' }),
  ).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Channels' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('form', { name: 'Message your team' }),
  ).toHaveCount(0);
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
  await onboard(page, hub);
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
  await page
    .getByRole('button', { name: 'View Revoked Activity activity' })
    .click();
  await showTechnical(page);
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
    page.getByText(
      'Activity can’t be loaded right now. It will try again on the next refresh.',
    ),
  ).toBeVisible();
  await showTechnical(page);
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
    page.getByText(
      'You no longer have access to this activity. Sign in again or ask the team owner.',
    ),
  ).toBeVisible();
  await expect(page.getByText(thread, { exact: true })).toHaveCount(0);
  await expect(page.getByText('Last reported: unknown')).toHaveCount(0);
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
  hub: { origin: string; setup: string },
) {
  await page.route('**/api/workspace**', async (route) => {
    const response = await route.fetch();
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
  await onboard(page, hub);
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
  await page
    .getByRole('button', { name: 'View Mock Native Observer activity' })
    .click();
  await showTechnical(page);
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
  await page.setViewportSize({ width: 375, height: 1000 });
  const observation = await openMockNativeCard(page, context.request, hub);
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
  const check = page.getByRole('button', { name: 'Check in T3' });
  await check.click();
  await expect(page.getByText(/T3 confirms/)).toBeVisible();
  await expect(
    page.getByText('This run: interrupted · finished'),
  ).toBeVisible();
  await expect(page.getByText(/Open requests in this thread: 2/)).toBeVisible();
  await expect(page.getByText('Last reported: unknown')).toBeVisible();
  const link = page.getByRole('link', { name: 'Open in T3', exact: true });
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
  await expect(page.getByText(/T3 can’t be checked right now/)).toBeVisible();
  await expect(link).toHaveCount(0);
  await expect(page.getByText(/T3 confirms/)).toHaveCount(0);
  status = 200;
  for (const invalid of [
    { ...observation, verifiedUrl: 'javascript:alert(1)' },
    { ...observation, verifiedUrl: 't3-thread://MOCK-thread' },
    { ...observation, verifiedUrl: 'https://evil.invalid/wrong/thread' },
    {
      ...observation,
      verifiedUrl: 'https://evil.invalid/MOCK-environment/MOCK-thread',
    },
    {
      ...observation,
      reference: { ...observation.reference, runId: 'wrong-run' },
    },
    { ...observation, token: 'invalid-extra-field' },
  ]) {
    body = observation;
    await check.click();
    await expect(link).toBeVisible();
    body = invalid;
    await check.click();
    await expect(page.getByText(/T3 can’t be checked right now/)).toBeVisible();
    await expect(link).toHaveCount(0);
    await expect(page.getByText(/T3 confirms/)).toHaveCount(0);
  }
  expect((await context.request.get(hub.origin + '/api/me')).status()).toBe(
    200,
  );
});

for (const denied of [401, 403]) {
  test(`MOCK UI only: native HTTP ${String(denied)} purges native result and protected AG-UI card`, async ({
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
    await page.getByRole('button', { name: 'Check in T3' }).click();
    await expect(
      page.getByRole('link', { name: 'Open in T3', exact: true }),
    ).toBeVisible();
    status = denied;
    await page.getByRole('button', { name: 'Check in T3' }).click();
    await expect(
      page.getByText(
        'You no longer have access to this activity. Sign in again or ask the team owner.',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open in T3', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/T3 confirms/)).toHaveCount(0);
    await expect(page.getByText('MOCK-thread', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Last reported: unknown')).toHaveCount(0);
    expect((await context.request.get(hub.origin + '/api/me')).status()).toBe(
      200,
    );
  });
}
