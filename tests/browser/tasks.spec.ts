import type { APIRequestContext } from '@playwright/test';
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

/**
 * Proves the board reaches past its newest hundred tasks, and narrows to
 * yours, keeping that in the address across a reload.
 */
test('the board reaches older tasks and narrows to yours, kept across a reload', async ({
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
  // The oldest first, then a hundred more: the board holds the newest 100.
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
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  const board = page.getByRole('region', { name: '任务看板' });
  await expect(board.getByText('Grace decides this')).toBeVisible();
  await expect(board.getByText('The very first task')).toHaveCount(0);
  await board.getByRole('button', { name: '更早的任务' }).click();
  await expect(board.getByText('The very first task')).toBeVisible();
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
