import type { Page, APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
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
async function register(page: Page, name: string, role: string) {
  await page.getByRole('tab', { name: 'Agents & activity' }).click();
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
    await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
    await page.getByText('Start a topic', { exact: true }).click();
    await page.getByLabel('Topic title').fill('Release planning');
    await page
      .getByRole('button', { name: 'Create topic', exact: true })
      .click();
    await page
      .getByLabel('Topic', { exact: true })
      .selectOption({ label: 'Release planning' });
    const composer = page.getByRole('form', { name: 'Message your team' });
    const text =
      '<img src=x onerror="window.__injected=true"> Persistent hello';
    await composer.getByLabel('Message', { exact: true }).fill(text);
    await composer
      .getByLabel('Mention an agent')
      .selectOption({ label: 'Ada' });
    await composer.getByRole('button', { name: 'Send message' }).click();
    await expect(
      page
        .getByRole('list', { name: 'Channel messages' })
        .getByText(text, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Mentions: Ada')).toBeVisible();
    await page.reload();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    expect(await page.locator('.messages img').count()).toBe(0);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await expect(
      page.getByText('Snapshot connected', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
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
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
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
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    const alpha = page.getByRole('article', {
      name: 'Ship alpha',
      exact: true,
    });
    const beta = page.getByRole('article', { name: 'Ship beta', exact: true });
    await expect(
      alpha.getByText('review-requested', { exact: true }),
    ).toBeVisible();
    await alpha.getByLabel('Decision note').fill('Technical review complete');
    await alpha
      .getByRole('button', { name: 'Approve review', exact: true })
      .click();
    await expect(
      alpha.getByText('awaiting-human', { exact: true }),
    ).toBeVisible();
    await expect(
      beta.getByText('review-requested', { exact: true }),
    ).toBeVisible();
    await alpha.getByLabel('Decision note').fill('I accept the alpha outcome');
    await alpha
      .getByRole('button', { name: 'Accept task', exact: true })
      .click();
    await expect(alpha.getByText('accepted', { exact: true })).toBeVisible();
    await beta.getByLabel('Action', { exact: true }).selectOption('rework');
    await beta.getByLabel('Decision note').fill('Beta needs more work');
    await beta
      .getByRole('button', { name: 'Request rework', exact: true })
      .click();
    await expect(
      beta.getByText('rework-requested', { exact: true }),
    ).toBeVisible();
    await expect(alpha.getByText('accepted', { exact: true })).toBeVisible();
    await page.screenshot({
      path: 'artifacts/workspace-tasks.png',
      fullPage: true,
    });
    await alpha.getByRole('button', { name: 'Show activity' }).click();
    await expect(
      alpha.getByRole('heading', { name: 'Decision history' }),
    ).toBeVisible();
    await expect(alpha.getByText('I accept the alpha outcome')).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await expect(
      page
        .getByRole('article', { name: 'Ship alpha' })
        .getByText('accepted', { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('article', { name: 'Ship beta' })
        .getByText('rework-requested', { exact: true }),
    ).toBeVisible();
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
    page.getByText('AG-UI 1.0 · refreshed snapshot', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Last recorded: waiting')).toBeVisible();
  await expect(
    page.getByText('browser-fixture-thread', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open in T3 (link unavailable)' }),
  ).toBeDisabled();
  for (const status of ['failed', 'stopped', 'succeeded']) {
    expect(
      (
        await context.request.post(
          base + '/executions/' + correlation.id + '/events',
          { data: { state: status } },
        )
      ).status(),
    ).toBe(201);
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await expect(page.getByText('Last recorded: ' + status)).toBeVisible();
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
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
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
  await card.getByRole('button', { name: 'Claim task', exact: true }).click();
  await expect(card.getByText('in-progress', { exact: true })).toBeVisible();
  await card
    .getByLabel('Action', { exact: true })
    .selectOption('request-review');
  await card
    .getByLabel('Recipient', { exact: true })
    .selectOption('agent:' + state.agents[0].id);
  await card.getByLabel('Decision note').fill('Please review the human work');
  await card
    .getByRole('button', { name: 'Request review', exact: true })
    .click();
  await expect(
    card.getByText('review-requested', { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole('definition').filter({ hasText: /^Reviewer$/ }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await page.getByText('Channel details', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Leave channel', exact: true })
    .click();
  await expect(
    page.getByText('Welcome to your team', { exact: true }),
  ).toBeVisible();
  await page.getByText('Rejoin a channel', { exact: true }).click();
  await page.getByLabel('Known channel ID').fill(state.channel.id);
  await page.getByRole('button', { name: 'Join channel', exact: true }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(
    card.getByText('review-requested', { exact: true }),
  ).toBeVisible();
});

test('sidebar mutations block submission while workspace GET is loading or failing, then reconnect', async ({
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
  await page.getByText('Rejoin a channel', { exact: true }).click();
  await page.getByLabel('Known channel ID').fill(state.channel.id);
  const join = page.getByRole('form', { name: 'Rejoin membership' });
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  let release: () => void = () => {
    throw new Error('Workspace request not intercepted');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workspace?*', async (route) => {
    await held;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{}',
    });
  });
  await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
  await expect(page.getByText('Refreshing…', { exact: true })).toBeVisible();
  for (const form of [create, join]) {
    await expect(
      form.getByRole('button', { name: /Create channel|Join channel/ }),
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
  release();
  await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
  for (const form of [create, join]) {
    await expect(
      form.getByRole('button', { name: /Create channel|Join channel/ }),
    ).toBeDisabled();
    await form.evaluate((node) =>
      node.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
  }
  expect(posts).toBe(0);
  // Only GET is broken: real server POST remains reachable to the authenticated owner.
  const probe = await context.request.post(
    `${hub.origin}/api/teams/${state.team.id}/channels`,
    { data: { name: 'reachable-post', operationKey: randomUUID() } },
  );
  expect(probe.status()).toBe(201);
  await page.unroute('**/api/workspace?*');
  await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
  await expect(
    page.getByText('Snapshot connected', { exact: true }),
  ).toBeVisible();
  await join.getByRole('button', { name: 'Join channel', exact: true }).click();
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

  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
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
  await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
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
  await expect(
    page.getByRole('navigation', { name: 'Channels' }),
  ).toHaveCount(0);
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
  await expect(page.getByText(thread, { exact: true })).toBeVisible();

  await page.route('**/api/agui/**', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{}',
    });
  });
  await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
  await expect(
    page.getByText(
      'Execution snapshot unavailable. Use Reconnect / refresh to retry.',
    ),
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
  await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
  await expect(
    page.getByText(
      'Execution access no longer authorized. Sign in again or contact your team owner.',
    ),
  ).toBeVisible();
  await expect(page.getByText(thread, { exact: true })).toHaveCount(0);
  await expect(page.getByText('Last recorded: unknown')).toHaveCount(0);
  expect(denied).toBeGreaterThan(0);
  expect(
    (
      await context.request.get(
        `${hub.origin}/api/agui/${state.team.id}/${agent.id}`,
      )
    ).status(),
  ).toBe(200);
});
