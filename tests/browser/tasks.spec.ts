import type { APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { rawDatabase } from '../raw.js';
import { Task, TaskResult } from '../../src/domain/tasks.js';
import { pageOf } from '../../src/domain/communication.js';
import { test, expect } from './fixture.js';
import {
  backToBoard,
  inStage,
  newTask,
  register,
  signIn,
  taskPage,
} from './ui.js';
import { snapshot, agentGrant } from './helpers.js';

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
    await alpha.getByRole('link', { name: 'Ship alpha' }).click();
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
    await alpha.getByRole('link', { name: 'Ship alpha' }).click();
    await alphaPage.getByLabel('决定备注').fill('I accept the alpha outcome');
    await alphaPage
      .getByRole('button', { name: '验收通过', exact: true })
      .click();
    await expect(alphaPage.getByText('任务已关闭。')).toBeVisible();
    await backToBoard(page);
    await expect(inStage(page, '已完成', 'Ship alpha')).toBeVisible();
    await beta.getByRole('link', { name: 'Ship beta' }).click();
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
    await page.getByRole('link', { name: '看板', exact: true }).click();
    await expect(inStage(page, '已完成', 'Ship alpha')).toBeVisible();
    await expect(inStage(page, '进行中', 'Ship beta')).toBeVisible();
  } finally {
    await agent.dispose();
  }
});

/**
 * Proves every unfinished task is on the board however many came after it,
 * and the board narrows to yours, keeping that in the address across a
 * reload.
 */
test('every unfinished task is on the board, which narrows to yours, kept across a reload', async ({
  page,
  browser,
  context,
  hub,
}) => {
  test.setTimeout(120_000);
  await signIn(page, hub, 'ada@example.com');
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  const tasks = `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/tasks`;
  const create = (request: APIRequestContext, title: string) =>
    request.post(tasks, {
      data: {
        operationKey: randomUUID(),
        title,
        description: '',
        criteria: ['done'],
        topicId: null,
        owner: null,
        reviewer: null,
        sourceMessageId: null,
        sourceEventId: null,
      },
    });
  // The oldest first, then a hundred more.
  expect((await create(context.request, 'The very first task')).status()).toBe(
    201,
  );
  for (let n = 0; n < 100; n++)
    expect((await create(context.request, `Task ${String(n)}`)).status()).toBe(
      201,
    );
  // Someone else's task: not Ada's.
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    expect((await create(theirs.request, 'Grace decides this')).status()).toBe(
      201,
    );
  } finally {
    await theirs.close();
  }
  await page.getByRole('link', { name: '看板', exact: true }).click();
  const board = page.getByRole('region', { name: '任务看板' });
  await expect(board.getByText('Grace decides this')).toBeVisible();
  // However old, open work is in its column, with nothing to page through.
  await expect(inStage(page, '待开始', 'The very first task')).toBeVisible();
  await expect(board.getByRole('button', { name: '更早的任务' })).toHaveCount(
    0,
  );
  // Yours: Grace's task goes, and the address keeps it.
  await board.getByRole('button', { name: '我的', exact: true }).click();
  await expect(board.getByText('Grace decides this')).toHaveCount(0);
  await expect(page).toHaveURL(/who=mine/);
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: '任务看板' })
      .getByRole('button', { name: '我的', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('region', { name: '任务看板' }).getByText('Task 99'),
  ).toBeVisible();
  await expect(page.getByText('Grace decides this')).toHaveCount(0);
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
  await page.getByRole('link', { name: '聊天', exact: true }).click();
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
  await left.getByRole('link', { name: 'general', exact: true }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(page.getByRole('form', { name: '给团队发消息' })).toHaveCount(0);
  await page
    .getByRole('button', { name: '加入 #general', exact: true })
    .click();
  await expect(page.getByRole('form', { name: '给团队发消息' })).toBeVisible();
  // Nothing left to join: the list disappears.
  await expect(left).toHaveCount(0);
  await page.getByRole('link', { name: '看板', exact: true }).click();
  await expect(inStage(page, '审核中', 'Human owned task')).toBeVisible();
});

/**
 * Proves finished work runs the most recently finished first and reaches
 * back with 更早的任务, and a finished task the board doesn't hold still
 * opens by its address.
 */
test('finished work reaches back with 更早的任务, and an old one still opens by its address', async ({
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
  const created = state.tasks.items[0];
  if (!created || !state.channel) throw new Error('Task missing');
  const cancelled = await context.request.post(
    `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/tasks/${created.id}/cancel`,
    {
      data: {
        operationKey: randomUUID(),
        expectedVersion: created.version,
        note: 'Superseded',
      },
    },
  );
  expect(cancelled.status()).toBe(200);
  const task = TaskResult.parse(await cancelled.json()).task;
  // A hundred newer finished tasks, copied from it below the API.
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
  // The board starts with the most recently finished; 更早的任务 reaches
  // the rest.
  await page.keyboard.press('Escape');
  const board = page.getByRole('region', { name: '任务看板' });
  await board.getByRole('button', { name: '显示已取消' }).click();
  const done = board.getByRole('region', { name: '已完成' });
  await expect(done.getByRole('article').first()).toHaveAccessibleName(
    'Newer task 100',
  );
  await expect(
    board.getByRole('article', { name: 'The oldest task', exact: true }),
  ).toHaveCount(0);
  await board.getByRole('button', { name: '更早的任务' }).click();
  await expect(done.getByRole('article').last()).toHaveAccessibleName(
    'The oldest task',
  );
});

/**
 * Proves a high-priority task leads its column even when older, and a task
 * past its day shows the day in the danger colour, on its card and page.
 */
test('a high-priority task leads its column; a late one shows its day as late', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const urgent = await newTask(page, {
    title: 'Urgent fix',
    criteria: ['Fixed'],
    priority: 'high',
    due: '2020-01-02',
  });
  await expect(urgent.locator('.task-due')).toHaveAttribute(
    'data-late',
    'true',
  );
  await backToBoard(page);
  await newTask(page, { title: 'Routine', criteria: ['Done'] });
  await backToBoard(page);
  // Newer, yet after: what matters most comes first.
  await expect(
    page
      .getByRole('region', { name: '待开始', exact: true })
      .locator('.task-card'),
  ).toHaveText([/Urgent fix/, /Routine/]);
  const card = inStage(page, '待开始', 'Urgent fix');
  await expect(card.getByTitle('高优先级')).toBeVisible();
  await expect(card.locator('.card-due')).toHaveAttribute('data-late', 'true');
  await expect(
    inStage(page, '待开始', 'Routine').locator('.card-due'),
  ).toHaveCount(0);
});

/**
 * Proves a task's acceptor edits it on its own page (Esc leaves it as it
 * was), the page shows it as edited, and history says what changed.
 */
test('the acceptor edits a task in place and history says what changed', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  let task = await newTask(page, {
    title: 'Draft title',
    criteria: ['Tests pass'],
  });
  // Nobody has started it: its acceptor can give it to someone.
  await expect(
    task.getByRole('button', { name: '指派负责人', exact: true }),
  ).toBeVisible();
  await task.getByRole('button', { name: '编辑任务', exact: true }).click();
  const form = task.getByRole('form', { name: '编辑任务' });
  await form.getByLabel('任务标题').fill('Something else');
  await form.getByLabel('任务标题').press('Escape');
  await expect(form).toHaveCount(0);
  await expect(
    task.getByRole('heading', { name: 'Draft title' }),
  ).toBeVisible();
  await task.getByRole('button', { name: '编辑任务', exact: true }).click();
  await form.getByLabel('任务标题').fill('Final title');
  await form.getByLabel('完成标准', { exact: true }).press('Enter');
  await form.getByLabel('完成标准 2', { exact: true }).fill('Docs updated');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  task = taskPage(page, 'Final title');
  await expect(
    task.getByRole('heading', { name: 'Final title' }),
  ).toBeVisible();
  await expect(task.locator('.criteria li')).toHaveText([
    'Tests pass',
    'Docs updated',
  ]);
  await expect(task.getByRole('region', { name: '记录' })).toContainText(
    '修改了标题、完成标准',
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
  await page.getByRole('link', { name: '看板', exact: true }).click();
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
test('a wide tablet keeps the board, one stage, beside the task that is open', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.getByRole('link', { name: '看板', exact: true }).click();
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
  const boardTab = page.getByRole('link', { name: '看板', exact: true });
  await expect(boardTab).toHaveAttribute('aria-current', 'page');
  await boardTab.click();
  await expect(task).toHaveCount(0);
  await expect(board).toBeVisible();
});

/**
 * Proves a card is a link to its task's page: a modified click opens that
 * address in a new tab, a plain one opens the task here and the title
 * follows; a card's title is a heading one level under its stage's.
 */
test('a card is a link to its task, titled one level under its stage', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await newTask(page, { title: 'Ship links', criteria: ['Links open'] });
  await backToBoard(page);
  await expect(page).toHaveTitle('看板 · # general · Kinmesh');
  const stage = page.getByRole('region', { name: '待开始', exact: true });
  await expect(
    stage.getByRole('heading', { level: 3, name: '待开始' }),
  ).toBeVisible();
  const card = stage.getByRole('article', { name: 'Ship links' });
  await expect(
    card.getByRole('heading', { level: 4, name: 'Ship links' }),
  ).toBeVisible();
  const link = card.getByRole('link', { name: 'Ship links' });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/\?(channel=[^&]+&)?task=[0-9a-f-]{36}$/);
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    link.click({ modifiers: ['ControlOrMeta'] }),
  ]);
  await expect(tab).toHaveURL(hub.origin + (href ?? ''));
  await expect(taskPage(tab, 'Ship links')).toBeVisible();
  await expect(tab).toHaveTitle('Ship links · Kinmesh');
  await tab.close();
  // Here the board stays.
  await expect(card).toBeVisible();
  await link.click();
  await expect(taskPage(page, 'Ship links')).toBeVisible();
  await expect(page).toHaveURL(hub.origin + (href ?? ''));
  await expect(page).toHaveTitle('Ship links · Kinmesh');
});

/**
 * Proves a narrow board's other stages are hidden until found: their tasks
 * are out of sight, yet a find-in-page match in one (its `beforematch`)
 * switches the board to that stage, with the task on screen.
 */
test('find in page reaches a task in a stage a narrow board isn’t showing', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await newTask(page, { title: 'Hidden until found', criteria: ['Found'] });
  await backToBoard(page);
  await page.setViewportSize({ width: 800, height: 900 });
  const stages = page.getByRole('group', { name: '阶段' });
  await stages.getByRole('button', { name: '已完成' }).click();
  const proposed = page.locator('.board-column[aria-label="待开始"]');
  await expect(proposed).toHaveAttribute('hidden', 'until-found');
  const card = page.getByRole('article', { name: 'Hidden until found' });
  await expect(card).toBeHidden();
  // What the browser does on a match there, before it scrolls to it.
  await proposed.dispatchEvent('beforematch');
  await expect(stages.getByRole('button', { name: '待开始' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(proposed).not.toHaveAttribute('hidden');
  await expect(card).toBeVisible();
  await expect(
    page.locator('.board-column[aria-label="已完成"]'),
  ).toHaveAttribute('hidden', 'until-found');
  // Where every stage shows, none is hidden.
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const name of ['待开始', '进行中', '审核中', '待验收', '已完成'])
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
});

/**
 * Proves the reviewer, with the task open, sees under each criterion what
 * its agent offered for it the moment it asks for review: its words, its PR
 * (said there and not again under PR), an address and a message that opens
 * in the conversation; a criterion it offered nothing for shows nothing.
 */
test('asking for review, the agent’s proof appears under each criterion on the open task', async ({
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
  const agent = await playwright.request.newContext({
    extraHTTPHeaders: { authorization: 'Bearer ' + token },
  });
  try {
    await newTask(page, {
      title: 'Ship gamma',
      criteria: ['Tests pass', 'Deployed', 'Docs updated'],
      owner: 'agent:' + developer.id,
      reviewer: 'human:' + state.human.id,
    });
    const open = taskPage(page, 'Ship gamma');
    await expect(open).toBeVisible();
    const channel = `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}`;
    const base = channel + '/tasks';
    let task = pageOf(Task).parse(
      await (await context.request.get(base)).json(),
    ).items[0];
    if (!task) throw new Error('The task was not created');
    const message = await agent.post(channel + '/messages', {
      data: {
        operationKey: randomUUID(),
        body: 'Deployed to staging',
        topicId: null,
        mentions: [],
        sourceMessageId: null,
        sourceEventId: null,
      },
    });
    expect(message.status()).toBe(201);
    const messageId = z
      .object({ id: z.string() })
      .parse(await message.json()).id;
    const linked = await agent.post(
      base + '/' + task.id + '/link-pull-request',
      {
        data: {
          operationKey: randomUUID(),
          expectedVersion: task.version,
          pullRequest: { repository: 'acme/widgets', number: 7 },
        },
      },
    );
    expect(linked.status()).toBe(200);
    task = TaskResult.parse(await linked.json()).task;
    const asked = await agent.post(base + '/' + task.id + '/request-review', {
      data: {
        operationKey: randomUUID(),
        expectedVersion: task.version,
        note: 'Ready',
        reviewer: { kind: 'human', id: state.human.id },
        proof: [
          {
            criterion: 0,
            words: 'CI passes on the PR',
            pieces: [
              {
                kind: 'pull-request',
                pullRequest: { repository: 'acme/widgets', number: 7 },
              },
              { kind: 'link', url: 'https://ci.example.com/build/12' },
            ],
          },
          { criterion: 1, pieces: [{ kind: 'message', messageId }] },
        ],
      },
    });
    expect(asked.status()).toBe(200);

    const criterion = (text: string) =>
      open
        .getByRole('listitem')
        .filter({ has: page.getByText(text, { exact: true }) });
    const tests = criterion('Tests pass');
    await expect(tests.getByText('CI passes on the PR')).toBeVisible();
    await expect(
      tests.getByRole('link', { name: 'acme/widgets#7' }),
    ).toBeVisible();
    await expect(
      tests.getByRole('link', { name: 'ci.example.com/build/12' }),
    ).toHaveAttribute('href', 'https://ci.example.com/build/12');
    await expect(criterion('Docs updated')).toHaveText('Docs updated');
    // The PR is said under its criterion, not again under PR.
    await expect(
      open
        .getByRole('region', { name: 'PR' })
        .getByRole('link', { name: 'acme/widgets#7' }),
    ).toHaveCount(0);
    // Under review the criteria the proof is for are shown, not written.
    await open.getByRole('button', { name: '编辑任务', exact: true }).click();
    const editing = page.getByRole('form', { name: '编辑任务' });
    await expect(
      editing.getByText('Tests pass', { exact: true }),
    ).toBeVisible();
    await expect(editing.getByLabel('完成标准', { exact: true })).toHaveCount(
      0,
    );
    await editing.getByRole('button', { name: '取消', exact: true }).click();
    await criterion('Deployed')
      .getByRole('button', { name: /Developer 的消息/ })
      .click();
    await expect(
      page
        .getByRole('list', { name: '频道消息' })
        .getByText('Deployed to staging'),
    ).toBeVisible();
  } finally {
    await agent.dispose();
  }
});

/**
 * Proves a card moving between columns moves alone: as its transition
 * starts, the page isn't captured to cross-fade, and a click on the board's
 * filter reaches the filter, not the transition's layer.
 */
test('a card moving on the board leaves the page still and taking clicks', async ({
  page,
  context,
  hub,
}) => {
  // What the page is like as each transition is ready to run.
  await page.addInitScript(() => {
    const seen: { root: string; rootAnimated: boolean; hit: boolean }[] = [];
    Reflect.set(window, '__transitions', seen);
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (update?: ViewTransitionUpdateCallback) => {
      const transition = start(update);
      void transition.ready.then(() => {
        const filter = document.querySelector('.board-filter button');
        if (!filter) return;
        const box = filter.getBoundingClientRect();
        seen.push({
          root: getComputedStyle(document.documentElement).viewTransitionName,
          rootAnimated: document
            .getAnimations()
            .some(
              (a) =>
                a.effect instanceof KeyframeEffect &&
                (a.effect.pseudoElement ?? '').includes('(root)'),
            ),
          hit:
            document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2,
            ) === filter,
        });
      });
      return transition;
    };
  });
  await signIn(page, hub);
  await newTask(page, { title: 'Moves on', criteria: ['Moved'] });
  await backToBoard(page);
  const state = await snapshot(context.request, hub.origin);
  const task = state.tasks.items[0];
  if (!task || !state.channel) throw new Error('Task missing');
  // Someone else moves it: the board shows it travel.
  const cancelled = await context.request.post(
    `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/tasks/${task.id}/cancel`,
    {
      data: {
        operationKey: randomUUID(),
        expectedVersion: task.version,
        note: 'Not needed',
      },
    },
  );
  expect(cancelled.status()).toBe(200);
  const seen = async () =>
    z
      .array(
        z.object({
          root: z.string(),
          rootAnimated: z.boolean(),
          hit: z.boolean(),
        }),
      )
      .parse(
        await page.evaluate((): unknown =>
          Reflect.get(window, '__transitions'),
        ),
      );
  await expect.poll(async () => (await seen()).length).toBeGreaterThan(0);
  expect((await seen())[0]).toEqual({
    root: 'none',
    rootAnimated: false,
    hit: true,
  });
});

/**
 * Proves a phone's board shows all five stages in its pills, each wholly
 * inside the board, with nothing to scroll sideways.
 */
test('a phone’s board shows every stage in its pills', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await page.setViewportSize({ width: 375, height: 800 });
  const state = await snapshot(context.request, hub.origin);
  await page.goto(
    `${hub.origin}/?channel=${state.channel?.id ?? ''}&view=board`,
  );
  const pills = page.getByRole('group', { name: '阶段' });
  await expect(pills.getByRole('button')).toHaveCount(5);
  const box = await pills.boundingBox();
  if (!box) throw new Error('Stage pills missing');
  for (const pill of await pills.getByRole('button').all()) {
    const each = await pill.boundingBox();
    if (!each) throw new Error('Stage pill missing');
    expect(each.x).toBeGreaterThanOrEqual(box.x);
    expect(each.x + each.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
  expect(await pills.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});
