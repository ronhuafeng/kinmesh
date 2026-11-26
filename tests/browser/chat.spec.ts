import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { rawDatabase } from '../raw.js';
import { Task } from '../../src/domain/tasks.js';
import { pageOf } from '../../src/domain/communication.js';
import { test, expect } from './fixture.js';
import {
  backToBoard,
  createChannel,
  inStage,
  openAgent,
  register,
  signIn,
  taskPage,
} from './ui.js';
import {
  recordCopies,
  snapshot,
  withoutStream,
  agentGrant,
  seedMessages,
  topOf,
  readAgain,
  atBottom,
  takesTaps,
} from './helpers.js';

/**
 * Proves what someone else writes while you are in the conversation is read
 * out to a screen reader: who, then what, in a polite live region.
 */
test('a message from someone else is announced politely as it arrives', async ({
  page,
  browser,
  hub,
}) => {
  await signIn(page, hub, 'ada@example.com');
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    const composer = grace.getByRole('form', { name: '给团队发消息' });
    await composer.getByLabel('消息', { exact: true }).fill('Hi **Ada**');
    await composer.getByRole('button', { name: '发送消息' }).click();
    const said = page.locator('[aria-live="polite"].visually-hidden');
    await expect(said).toHaveText('Grace Hopper：Hi Ada');
  } finally {
    await theirs.close();
  }
});
/**
 * Proves a channel opens where you stopped reading: what someone else wrote
 * while you were elsewhere starts under the "new since" line, in view, and
 * the newest is one press away.
 */
test('a channel opens at the first message you haven’t read, and the newest is one press away', async ({
  page,
  browser,
  hub,
}) => {
  await signIn(page, hub, 'ada@example.com');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  // Read up to here, then elsewhere.
  await field.fill('Read before leaving');
  await composer.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('Read before leaving')).toBeVisible();
  await createChannel(page, 'design');
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    const hers = grace.getByRole('form', { name: '给团队发消息' });
    for (const n of Array.from({ length: 40 }, (_, i) => i)) {
      await hers.getByLabel('消息', { exact: true }).fill(`Grace ${String(n)}`);
      await hers.getByRole('button', { name: '发送消息' }).click();
      await expect(
        grace.getByText(`Grace ${String(n)}`, { exact: true }),
      ).toBeVisible();
    }
  } finally {
    await theirs.close();
  }
  await page
    .getByRole('navigation', { name: '频道' })
    .getByRole('link', { name: /^general( |$)/ })
    .click();
  const first = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Grace 0' });
  await expect(first).toBeInViewport();
  await expect(page.getByText(/以来的新消息/)).toBeVisible();
  const newest = page.getByText('Grace 39', { exact: true });
  await expect(newest).not.toBeInViewport();
  await page.getByRole('button', { name: '回到最新 ↓' }).click();
  await expect(newest).toBeInViewport();
  await expect(page.getByRole('button', { name: '回到最新 ↓' })).toHaveCount(0);
});
/**
 * Proves a channel with unread messages opens at the first of them without
 * passing the bottom: at no scroll and no frame while it opens is the
 * newest message on screen, and the channel is told read only once the
 * newest has been seen.
 */
test('a channel opens at its first unread without passing the bottom, and is read only once the newest is seen', async ({
  page,
  context,
  browser,
  hub,
}) => {
  await signIn(page, hub, 'ada@example.com');
  const state = await snapshot(context.request, hub.origin);
  const general = state.channel;
  if (!general) throw new Error('Local channel missing');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill('Read before leaving');
  await composer.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByText('Read before leaving')).toBeVisible();
  await createChannel(page, 'design');
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    for (const n of Array.from({ length: 40 }, (_, i) => i)) {
      const response = await grace.request.post(
        `${hub.origin}/api/teams/${state.team.id}/channels/${general.id}/messages`,
        {
          data: {
            operationKey: randomUUID(),
            body: `Grace ${String(n)}`,
            topicId: null,
            mentions: [],
            sourceMessageId: null,
            sourceEventId: null,
          },
        },
      );
      expect(response.status()).toBe(201);
    }
  } finally {
    await theirs.close();
  }
  const unread = async () =>
    (await snapshot(context.request, hub.origin)).latest.find(
      (l) => l.channelId === general.id,
    )?.unread;
  expect(await unread()).toBe(true);
  // Every scroll and every frame from here on: was the newest on screen?
  await page.evaluate(() => {
    const look = () => {
      const newest = [
        ...document.querySelectorAll('.messages > li[id^="message-"]'),
      ].find((li) => li.textContent.includes('Grace 39'));
      const box = newest?.getBoundingClientRect();
      if (box && box.bottom > 0 && box.top < window.innerHeight)
        document.documentElement.dataset.sawNewest = 'true';
    };
    window.addEventListener('scroll', look, { passive: true });
    const frame = () => {
      look();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const told: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/read'))
      told.push(request.url());
  });
  await page
    .getByRole('navigation', { name: '频道' })
    .getByRole('link', { name: /^general( |$)/ })
    .click();
  const messages = page.getByRole('list', { name: '频道消息' });
  await expect(
    messages.getByRole('listitem').filter({ hasText: 'Grace 0' }).first(),
  ).toBeInViewport();
  await expect(page.getByText(/以来的新消息/)).toBeVisible();
  const newest = messages.getByText('Grace 39', { exact: true });
  await expect(newest).not.toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.dataset.sawNewest),
  ).toBeUndefined();
  // Still unread: nothing was told while the newest was out of sight.
  expect(told).toEqual([]);
  expect(await unread()).toBe(true);
  // Reaching the newest reads it.
  await page.getByRole('button', { name: '回到最新 ↓' }).click();
  await expect(newest).toBeInViewport();
  await expect.poll(unread).toBe(false);
  expect(told).toHaveLength(1);
});

test('keyboard mention, and a message becomes a task in its topic', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  await page.getByRole('button', { name: '新建话题' }).click();
  await page.getByLabel('话题名称').fill('Billing');
  await page.getByLabel('话题名称').press('Enter');
  // The topic just made opens, with the composer ready to type in.
  await expect(
    page
      .getByRole('list', { name: '话题' })
      .getByRole('button', { name: 'Billing', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const message = composer.getByLabel('消息', { exact: true });
  await expect(message).toBeFocused();
  // No wait for the topic refresh: typing must survive a background reload.
  await message.fill('Validate postal codes per country');
  await message.pressSequentially(' @a');
  await expect(message).toHaveValue('Validate postal codes per country @a');
  await expect(
    page.getByRole('option', { name: /Ada/, selected: true }),
  ).toBeVisible();
  await message.press('Enter');
  await expect(message).toHaveValue('Validate postal codes per country @Ada ');
  await expect(
    composer.getByRole('list', { name: '提及' }).getByText('@Ada'),
  ).toBeVisible();
  // Sent while the topic switch may still be refreshing: it must go through.
  await message.press('ControlOrMeta+Enter');
  const posted = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Validate postal codes per country @Ada' });
  await expect(posted).toBeVisible();
  // Sending keeps the keyboard: the next message can be typed at once.
  await expect(message).toBeFocused();
  await expect(message).toHaveValue('');
  await posted.getByRole('button', { name: '转为任务', exact: true }).click();
  await expect(
    page.getByRole('link', { name: '看板', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  const form = page.getByRole('form', { name: '新任务' });
  await expect(form.getByLabel('任务标题')).toHaveValue(
    'Validate postal codes per country @Ada',
  );
  await expect(
    page.getByText('来自 browser_owner 的消息', { exact: true }),
  ).toBeVisible();
  await form.getByLabel('完成标准').fill('Postal codes validated per country');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada || !state.channel) throw new Error('Local fixture unavailable');
  await form
    .getByLabel('负责人', { exact: true })
    .selectOption('agent:' + ada.id);
  await form.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(
    taskPage(page, 'Validate postal codes per country @Ada'),
  ).toBeVisible();
  await backToBoard(page);
  const card = page.getByRole('article', {
    name: 'Validate postal codes per country @Ada',
  });
  await expect(
    inStage(page, '进行中', 'Validate postal codes per country @Ada'),
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
  // Search, from the magnifier by the team name, jumps straight to the task; only its acceptor may cancel it, with a note.
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const search = page.getByRole('combobox', { name: /搜索/ });
  await search.fill('postal 进行中');
  await expect(
    page
      .getByRole('listbox', { name: '结果' })
      .getByRole('option', { name: /Validate postal codes/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(search).toBeHidden();
  const task = taskPage(page, 'Validate postal codes per country @Ada');
  await expect(task).toBeVisible();
  // Cancelling is the last of the quiet row; chosen, its note opens in place.
  await task.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(task.getByText(/不经验收直接关闭任务/)).toBeVisible();
  await task.getByLabel('决定备注').fill('Superseded by the new form');
  await task.getByRole('button', { name: '取消任务', exact: true }).click();
  // Cancelled work leaves the board quietly; it is one click away in Done.
  await expect(task.getByText('任务已关闭。')).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '显示已取消', exact: true }).click();
  await expect(
    inStage(page, '已完成', 'Validate postal codes per country @Ada').getByText(
      '已取消',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: '任务已取消。' }),
  ).toBeVisible();
});

test('a mention says what happened to it and leads to the agent’s reply, said once', async ({
  page,
  context,
  playwright,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  const ada = state.agents[0];
  if (!ada || !state.channel) throw new Error('Local fixture unavailable');
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const item = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text })
      .first();
  // Said once the hub has it: it is in the workspace, no longer on its way.
  const say = async (text: string) => {
    await composer.getByLabel('消息', { exact: true }).fill(text);
    await composer.getByRole('button', { name: '发送消息' }).click();
    await expect(item(text)).toBeVisible();
    await expect(item(text)).not.toHaveAttribute('data-pending');
  };
  await say('@Ada please check the release notes');
  const asked = item('please check the release notes');
  const responses = asked.getByRole('list', { name: '智能体响应' });
  // Each delivery state's sentence: tests/delivery-copy.test.ts.
  await expect(responses).toContainText('Ada 离线');
  const token = await agentGrant(
    context.request,
    hub.origin,
    state.team.id,
    ada.id,
  );
  const agent = await playwright.request.newContext({
    extraHTTPHeaders: { authorization: 'Bearer ' + token },
  });
  /** What the worker does on success: Ada replies, and the delivery is acknowledged with that reply. */
  const answer = async (question: string, body: string) => {
    const source = (
      await snapshot(context.request, hub.origin)
    ).messages.items.find((m) => m.body.includes(question));
    if (!source || !state.channel) throw new Error('Mention not persisted');
    const posted = await agent.post(
      `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/messages`,
      {
        data: {
          operationKey: randomUUID(),
          body,
          topicId: null,
          mentions: [],
          sourceMessageId: source.id,
          sourceEventId: null,
        },
      },
    );
    expect(posted.status()).toBe(201);
    const reply = z.object({ id: z.uuid() }).parse(await posted.json());
    const db = rawDatabase(hub.database);
    try {
      await db
        .prepare(
          "UPDATE agent_inbox SET state = 'acked', reason = 'assistant-result-published', result_message_id = ? WHERE message_id = ?",
        )
        .run(reply.id, source.id);
    } finally {
      await db.close();
    }
  };
  try {
    // Something else is said before Ada answers: the line leads to her
    // reply, and the reply quotes what it answers.
    await say('Meanwhile, the docs build is green');
    await answer(
      'please check the release notes',
      'Release notes checked; two links were broken and are fixed.',
    );
    await responses.getByRole('button', { name: /Ada 已回复/ }).click();
    const reply = item('two links were broken');
    await expect(reply).toBeInViewport();
    await expect(
      reply.getByRole('button', { name: /回复 browser_owner/ }),
    ).toBeVisible();
    // Answered right under the question, neither is said: the reply's place
    // says it.
    await say('@Ada and the changelog?');
    await answer('and the changelog?', 'The changelog lists both fixes.');
    const next = item('The changelog lists both fixes.');
    await expect(next).toBeVisible();
    await expect(
      item('and the changelog?').getByRole('list', { name: '智能体响应' }),
    ).toHaveCount(0);
    await expect(next.getByRole('button', { name: /^回复 / })).toHaveCount(0);
  } finally {
    await agent.dispose();
  }
});
/**
 * Proves going to an agent's reply from its page always reaches it: a
 * reply far older than the messages the conversation has read opens the
 * conversation at it, marked.
 */
test('an agent’s reply older than the messages read opens from its page, shown and marked', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local fixture unavailable');
  // A history longer than the workspace's window; the reply is its third.
  await seedMessages(hub.database, state.channel.id, state.human.id, 260);
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill('@Ada please check the release notes');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const asked = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'please check the release notes' });
  await expect(asked).not.toHaveAttribute('data-pending');
  const db = rawDatabase(hub.database);
  let reply = '';
  try {
    reply = z
      .string()
      .parse(
        await db
          .prepare(
            "SELECT id FROM messages WHERE channel_id = ? AND body = 'Message 3'",
          )
          .pluck()
          .get(state.channel.id),
      );
    const source = z
      .string()
      .parse(
        await db
          .prepare(
            "SELECT id FROM messages WHERE channel_id = ? AND body LIKE '%please check the release notes'",
          )
          .pluck()
          .get(state.channel.id),
      );
    await db
      .prepare(
        "UPDATE agent_inbox SET state = 'acked', reason = 'assistant-result-published', result_message_id = ? WHERE message_id = ?",
      )
      .run(reply, source);
  } finally {
    await db.close();
  }
  await readAgain(page);
  const agent = await openAgent(page, 'Ada');
  await agent.getByRole('button', { name: '查看回复' }).click();
  const row = page.locator('#message-' + reply);
  await expect(row).toBeInViewport({ timeout: 20_000 });
  await expect(row).toContainText('Message 3');
  await expect(row).toHaveAttribute('data-flash', 'true');
  await expect(page).toHaveURL(new RegExp('message=' + reply));
});

/**
 * Proves an input method keeps its keys: the Enter that commits a pinyin
 * candidate never chooses from the @ list; a plain Enter then does.
 */
test('Enter committing an input method candidate never picks from the @ list', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  await field.pressSequentially('@Ad');
  const list = page.getByRole('listbox', { name: '可提及的成员' });
  await expect(list).toBeVisible();
  for (const init of [
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 },
  ])
    await field.dispatchEvent('keydown', { ...init, bubbles: true });
  await expect(field).toHaveValue('@Ad');
  await expect(composer.getByRole('list', { name: '提及' })).toHaveCount(0);
  await expect(list).toBeVisible();
  await field.press('Enter');
  await expect(composer.getByRole('list', { name: '提及' })).toContainText(
    '@Ada',
  );
});

/**
 * Proves removing a mention takes it back: the chip and the `@Name` written
 * for it go, and the message reaches no agent.
 */
test('removing a mention chip takes the mention out of the message', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Ada', 'developer');
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  await field.pressSequentially('@Ad');
  await page
    .getByRole('listbox', { name: '可提及的成员' })
    .getByRole('option', { name: /Ada/ })
    .click();
  await field.pressSequentially('only a note');
  await composer.getByRole('button', { name: '移除对 Ada 的提及' }).click();
  await expect(field).toHaveValue('only a note');
  await expect(composer.getByRole('list', { name: '提及' })).toHaveCount(0);
  await composer.getByRole('button', { name: '发送消息' }).click();
  const sent = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'only a note' });
  await expect(sent).toBeVisible();
  await expect(sent.getByRole('list', { name: '智能体响应' })).toHaveCount(0);
});

/**
 * Proves an `@` reaches only the agent it names, even when another's name
 * starts it: the one chosen from the list, or the whole name typed. And that
 * the step a run is on stays inside its message, cut to one line, however
 * long.
 */
test('@ reaches only the agent chosen or named in full, and a long step stays inside its message', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await register(page, 'Pi', 'developer');
  await register(page, 'Pi 2', 'developer');
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  const responsesTo = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text })
      .first()
      .getByRole('list', { name: '智能体响应' });
  // Chosen from the list: `@Pi` offers both, and Pi 2 is the one chosen.
  await field.pressSequentially('@Pi');
  await page
    .getByRole('listbox', { name: '可提及的成员' })
    .getByRole('option', { name: /Pi 2/ })
    .click();
  await field.pressSequentially('report on the MCP design');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const responses = responsesTo('report on the MCP design');
  await expect(responses.getByRole('listitem')).toHaveCount(1);
  await expect(responses).toContainText('Pi 2 离线');
  // Typed in full, without the list.
  await field.fill('@Pi 2 draw its architecture');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const typed = responsesTo('draw its architecture');
  await expect(typed.getByRole('listitem')).toHaveCount(1);
  await expect(typed).toContainText('Pi 2 离线');
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'report on the MCP design' })
    .first();
  // Its run is under way in T3, on a step far longer than the message.
  const step = `/bin/bash -lc "cd ppap && cat AGENTS.md | rg -n 'MCP|design|architecture' ${'docs/ '.repeat(30)}"`;
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        "UPDATE agent_inbox SET state = 'waiting', reason = 'execution-active', step = ?, reference = ? WHERE state = 'ready'",
      )
      .run(
        step,
        JSON.stringify({
          backend: 't3',
          environmentId: 'env-mock',
          threadId: 'thread-mock',
          runId: 'run-mock',
        }),
      );
  } finally {
    await sql.close();
  }
  const shown = responses.locator('.delivery-step');
  await expect(shown).toContainText('cd ppap');
  const [row, lines] = await Promise.all([
    message.boundingBox(),
    responses.boundingBox(),
  ]);
  expect(row && lines && lines.x + lines.width <= row.x + row.width).toBe(true);
  // Cut, not wrapped, and the page never scrolls sideways.
  expect(await shown.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

/**
 * Proves a message the hub refuses for good says why and offers only to let
 * it go, while a lost answer still offers to send it again.
 */
test('a message the hub refuses says why and offers only 删除, never Retry', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.route('**/api/teams/*/channels/*/messages', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 403, json: {} })
      : route.continue(),
  );
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('Not allowed here');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const sent = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Not allowed here' });
  await expect(sent).toContainText('没发出去：你已不能在这个频道发消息。');
  await expect(sent.getByRole('button', { name: '重试' })).toHaveCount(0);
  await sent.getByRole('button', { name: '删除' }).click();
  await expect(sent).toHaveCount(0);
});

test('lost message response retries the same committed operation; real conflict stays visible', async ({
  page,
  context,
  hub,
}) => {
  // Nothing arrives on its own: the view reads the workspace when asked.
  await withoutStream(page);
  await signIn(page, hub);
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
  // The workspace isn't read again until the retry has gone, so the
  // committed message can't arrive on its own first.
  let release: () => void = () => {
    throw new Error('Workspace read not held');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/workspace?*', async (route) => {
    await held;
    await route.continue();
  });
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const text = 'One committed message, even after a lost response';
  await composer.getByLabel('消息', { exact: true }).fill(text);
  await composer.getByRole('button', { name: '发送消息' }).click();
  const sent = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: text });
  await expect(sent).toHaveAttribute('data-pending', 'failed');
  await sent.getByRole('button', { name: '重试', exact: true }).click();
  release();
  await expect(sent).not.toHaveAttribute('data-pending');
  await expect(sent).toHaveCount(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const after = await snapshot(context.request, hub.origin);
  expect(after.messages.items).toHaveLength(1);
  await page.unroute('**/api/workspace?*');
  await register(page, 'Duplicate check', 'assistant');
  // Real server uniqueness conflict, not an intercepted/fabricated error response.
  await page.getByRole('link', { name: '成员', exact: true }).click();
  await page
    .getByRole('list', { name: '团队', exact: true })
    .getByRole('button', { name: '添加智能体', exact: true })
    .click();
  const form = page.getByRole('form', { name: '智能体资料' });
  await form.getByLabel('智能体名称').fill('Duplicate check');
  await form.getByRole('button', { name: '添加智能体', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('已有同名的智能体');
});

test('a message shows at once and settles in place; one that didn’t go is sent again once', async ({
  page,
  context,
  hub,
}) => {
  // Sending never waits on the server: the field is free at once, the
  // message shows faded where it will stay and comes to full strength in
  // the same place; one that didn't go stays, and its retry posts it once.
  await signIn(page, hub);
  const keys: string[] = [];
  let release: () => void = () => {
    throw new Error('First message not held');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/teams/*/channels/*/messages', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const body: unknown = route.request().postDataJSON();
    keys.push(z.object({ operationKey: z.string() }).parse(body).operationKey);
    if (keys.length === 1) {
      // The first is held until the test has seen it on its way.
      await held;
      await route.continue();
    } else if (keys.length === 2) await route.abort('failed');
    else await route.continue();
  });
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  const messages = page.getByRole('list', { name: '频道消息' });
  const item = (text: string) =>
    messages.getByRole('listitem').filter({ hasText: text });
  const strength = (text: string) =>
    item(text)
      .locator('.message-text')
      .evaluate((el) => getComputedStyle(el).opacity);
  await field.fill('On its way');
  await composer.getByRole('button', { name: '发送消息' }).click();
  // The field is empty and still has the focus; the message is there, faded.
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  const first = item('On its way');
  await expect(first).toHaveAttribute('data-pending', 'sending');
  expect(await strength('On its way')).toBe('0.5');
  // It arrives rising 6 px into place; measured once it is there.
  await expect
    .poll(() => first.evaluate((el) => el.getAnimations().length))
    .toBe(0);
  const box = await first.boundingBox();
  await first.evaluate((el) => {
    el.dataset.probe = 'shown';
  });
  // What is typed meanwhile stays.
  await field.fill('Written while it goes');
  release();
  await expect(first).not.toHaveAttribute('data-pending');
  // The same element, in the same place, at full strength.
  await expect(first).toHaveAttribute('data-probe', 'shown');
  expect(await first.boundingBox()).toEqual(box);
  await expect.poll(() => strength('On its way')).toBe('1');
  await expect(field).toHaveValue('Written while it goes');
  // The next one doesn't go: it stays where it was written and says so.
  await composer.getByRole('button', { name: '发送消息' }).click();
  const second = item('Written while it goes');
  await expect(second).toHaveAttribute('data-pending', 'failed');
  await expect(second).toContainText('没发出去');
  await expect(field).toHaveValue('');
  await second.getByRole('button', { name: '重试', exact: true }).click();
  await expect(second).not.toHaveAttribute('data-pending');
  await expect(second).toHaveCount(1);
  // Retried under its own key, it was posted exactly once.
  expect(keys).toHaveLength(3);
  expect(keys[2]).toBe(keys[1]);
  expect(keys[1]).not.toBe(keys[0]);
  const after = await snapshot(context.request, hub.origin);
  expect(after.messages.items.map((m) => m.body)).toEqual([
    'On its way',
    'Written while it goes',
  ]);
});

test('a long conversation opens at its newest message, follows new ones, holds still while read back, and reads older ones by scrolling up', async ({
  page,
  context,
  hub,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  await seedMessages(hub.database, state.channel.id, state.human.id, 120);
  const messages = page.getByRole('list', { name: '频道消息' });
  const say = (text: string) => messages.getByText(text, { exact: true });
  // It opens at the newest message, with nothing to page through.
  await page.reload();
  await expect(say('Message 120')).toBeInViewport();
  expect(await atBottom(page)).toBe(true);
  await expect(say('Message 70')).toHaveCount(0);
  // Scrolling to the top reads the page before; the first message's text
  // stays exactly where it was on screen, though its header folds into the
  // same author's older messages. The read is held until its place is
  // measured.
  let release: () => void = () => {
    throw new Error('The older page was not asked for');
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The older page is read, and watched, only once released.
  const reachBack = (url: URL) =>
    (url.pathname === '/api/workspace' || url.pathname === '/api/events') &&
    url.searchParams.has('messagesCursor');
  await page.route(reachBack, async (route) => {
    await held;
    await route.continue();
  });
  await page.evaluate(() => {
    window.scrollTo({ top: 0 });
  });
  // Measured at rest: the view rises into place as it opens, so read before
  // that ends, Message 71 is still on its way up.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .length,
      ),
    )
    .toBe(0);
  const first = await topOf(page, 'Message 71');
  release();
  await expect(say('Message 70')).toBeAttached();
  await page.unroute(reachBack);
  expect(Math.abs((await topOf(page, 'Message 71')) - first)).toBeLessThan(1);
  // Read back, a new message arrives at the end and nothing moves.
  const base = `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel.id}/messages`;
  const post = async (body: string) => {
    const response = await context.request.post(base, {
      data: {
        operationKey: randomUUID(),
        body,
        topicId: null,
        mentions: [],
        sourceMessageId: null,
        sourceEventId: null,
      },
    });
    expect(response.status()).toBe(201);
  };
  await post('Arrived while reading back');
  await readAgain(page);
  await expect(say('Arrived while reading back')).toBeAttached();
  expect(Math.abs((await topOf(page, 'Message 71')) - first)).toBeLessThan(1);
  // Further up, the start of the conversation.
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        window.scrollTo({ top: 0 });
      });
      return say('Message 1').count();
    })
    .toBe(1);
  // At the bottom, it stays at the bottom as messages arrive.
  await page.evaluate(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  });
  await post('Arrived at the bottom');
  await readAgain(page);
  await expect(say('Arrived at the bottom')).toBeInViewport();
  expect(await atBottom(page)).toBe(true);
  // What you send brings you back to it from anywhere.
  await page.evaluate(() => {
    window.scrollTo({ top: 0 });
  });
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('Sent from up top');
  await composer
    .getByLabel('消息', { exact: true })
    .press('ControlOrMeta+Enter');
  await expect(say('Sent from up top')).toBeInViewport();
});
/**
 * Proves coming back to a conversation keeps your place: read back to a
 * message from an older page, then go to 看板 and back, or to the Inbox and
 * back with the browser's Back, and that message is exactly where it was.
 */
test('coming back to a conversation, from another view or with Back, shows the message you were reading', async ({
  page,
  context,
  hub,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  await seedMessages(hub.database, state.channel.id, state.human.id, 120);
  await page.reload();
  const messages = page.getByRole('list', { name: '频道消息' });
  const say = (text: string) => messages.getByText(text, { exact: true });
  await expect(say('Message 120')).toBeInViewport();
  // Read back past the first page.
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        window.scrollTo({ top: 0 });
      });
      return say('Message 60').count();
    })
    .toBe(1);
  await say('Message 60').scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .length,
      ),
    )
    .toBe(0);
  // Reached from the top of the page, it stays where it was scrolled to.
  await expect(say('Message 60')).toBeInViewport();
  const at = await topOf(page, 'Message 60');
  const moved = async () => Math.abs((await topOf(page, 'Message 60')) - at);
  // Another view and back.
  await page.getByRole('link', { name: '看板', exact: true }).click();
  await expect(page.getByRole('region', { name: '任务看板' })).toBeVisible();
  await expect(say('Message 60')).toHaveCount(0);
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  await expect(say('Message 60')).toBeInViewport();
  await expect.poll(moved).toBeLessThan(1);
  // A page, and the browser's Back.
  await page
    .getByRole('navigation', { name: '收件箱' })
    .getByRole('button', { name: /^收件箱/ })
    .click();
  await expect(page).toHaveURL(/inbox/);
  await expect(say('Message 60')).toHaveCount(0);
  await page.goBack();
  await expect(say('Message 60')).toBeInViewport();
  await expect.poll(moved).toBeLessThan(1);
});

test('“New since” marks only what others wrote while this channel or topic was open', async ({
  page,
  browser,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  const messages = page.getByRole('list', { name: '频道消息' });
  const divider = page
    .getByRole('separator')
    .filter({ hasText: /以来的新消息/ });
  const theirs = await browser.newContext();
  try {
    const grace = await theirs.newPage();
    await signIn(grace, hub, 'grace@example.com');
    const graceSays = async (body: string) => {
      const response = await grace.request.post(
        `${hub.origin}/api/teams/${state.team.id}/channels/${state.channel?.id ?? ''}/messages`,
        {
          data: {
            operationKey: randomUUID(),
            body,
            topicId: null,
            mentions: [],
            sourceMessageId: null,
            sourceEventId: null,
          },
        },
      );
      expect(response.status()).toBe(201);
    };
    await graceSays('Grace wrote before');
    await expect(messages.getByText('Grace wrote before')).toBeVisible();
    await page.getByRole('button', { name: '新建话题' }).click();
    await page.getByLabel('话题名称').fill('Billing');
    await page.getByLabel('话题名称').press('Enter');
    const composer = page.getByRole('form', { name: '给团队发消息' });
    await composer.getByLabel('消息', { exact: true }).fill('In the topic');
    await composer.getByRole('button', { name: '发送消息' }).click();
    await expect(
      messages.getByRole('listitem').filter({ hasText: 'In the topic' }),
    ).not.toHaveAttribute('data-pending');
    // Reloaded inside the topic, then widened to All: what Grace wrote
    // before is not new, only out of the topic.
    await page.reload();
    await expect(messages.getByText('In the topic')).toBeVisible();
    await page
      .getByRole('list', { name: '话题' })
      .getByRole('button', { name: '全部', exact: true })
      .click();
    await expect(messages.getByText('Grace wrote before')).toBeVisible();
    await expect(divider).toHaveCount(0);
    // What she writes now is.
    await graceSays('Grace wrote this');
    await readAgain(page);
    await expect(
      messages.getByRole('listitem').filter({ hasText: 'Grace wrote this' }),
    ).toContainText('以来的新消息');
    await expect(divider).toHaveCount(1);
  } finally {
    await theirs.close();
  }
});

test('a phone channel: targets a finger can hit, fields that don’t zoom, a composer on the bottom edge', async ({
  browser,
  hub,
}) => {
  const phone = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await phone.newPage();
    await signIn(page, hub);
    const state = await snapshot(page.request, hub.origin);
    if (!state.channel) throw new Error('Local channel missing');
    await page.getByRole('button', { name: '新建话题' }).click();
    await page.getByLabel('话题名称').fill('Billing');
    await page.getByLabel('话题名称').press('Enter');
    await page
      .getByRole('list', { name: '话题' })
      .getByRole('button', { name: '全部', exact: true })
      .click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page
      .getByRole('navigation', { name: '频道' })
      .getByRole('link', { name: /^general( |$)/ })
      .click();
    const topics = page.getByRole('group', { name: '话题' });
    await expect(topics.getByRole('button', { name: 'Billing' })).toBeVisible();
    // Back keeps no chrome, so it is drawn at 44 px; the rest take taps
    // around them.
    const back = await page
      .getByRole('button', { name: '返回', exact: true })
      .boundingBox();
    expect(back?.width).toBeGreaterThanOrEqual(44);
    expect(back?.height).toBeGreaterThanOrEqual(44);
    for (const target of [
      '.view-switch a',
      '.topic-pills button[aria-pressed="false"]',
      '.topic-pills .topic-add',
    ])
      expect(await takesTaps(page, target)).toEqual([true, true, true, true]);
    // A pill and the "+" after it are one height.
    const heights = await page
      .locator('.topic-pills button')
      .evaluateAll((pills) =>
        pills.map((pill) => Math.round(pill.getBoundingClientRect().height)),
      );
    expect(new Set(heights).size).toBe(1);
    // Leaving is not among the topics a thumb taps all day; it waits where
    // the conversation begins.
    await expect(topics.getByRole('button', { name: '退出频道' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('button', { name: '退出频道', exact: true }),
    ).toBeVisible();
    // The field is 16 px (iOS zooms below that) and takes the width; Send is
    // the round confirm, shown once there is something to send.
    const composer = page.getByRole('form', { name: '给团队发消息' });
    const field = composer.getByLabel('消息', { exact: true });
    expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      '16px',
    );
    const send = composer.getByRole('button', { name: '发送消息' });
    await expect(send).toBeDisabled();
    // A file's small × takes a finger's 44 px around it.
    await composer.locator('input[type="file"]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('notes'),
    });
    const remove = composer.getByRole('button', { name: '移除 notes.txt' });
    await expect(remove).toBeVisible();
    expect(await takesTaps(page, '.composer-file-remove')).toEqual([
      true,
      true,
      true,
      true,
    ]);
    await remove.tap();
    await expect(remove).toHaveCount(0);
    await field.fill('Ship the release notes');
    await expect(send).toBeEnabled();
    // Only the paperclip, "@" and Send sit beside it: the rest is the
    // field's, but for the composer's padding and gaps. Widths are laid out,
    // not drawn, so Send growing in doesn't count.
    const width = (target: typeof field) =>
      target.evaluate((el) => (el instanceof HTMLElement ? el.offsetWidth : 0));
    const [fieldWidth, formWidth, attachWidth, atWidth, sendWidth] =
      await Promise.all([
        width(field),
        width(composer),
        width(composer.getByRole('button', { name: '添加文件' })),
        width(composer.getByRole('button', { name: '提及成员' })),
        width(send),
      ]);
    expect(fieldWidth + attachWidth + atWidth + sendWidth).toBeGreaterThan(
      formWidth - 56,
    );
    // Send grows in once there is something to send: measure it grown.
    await expect
      .poll(() => send.evaluate((el) => el.getAnimations().length))
      .toBe(0);
    expect(await takesTaps(page, '.composer button[type="submit"]')).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // "@" and Send share a centre.
    const centre = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.top + box.height / 2;
      });
    expect(
      Math.abs(
        (await centre('.composer .mention-trigger')) -
          (await centre('.composer button[type="submit"]')),
      ),
    ).toBeLessThan(1);
    await send.tap();
    const posted = page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: 'Ship the release notes' });
    await expect(posted).toBeVisible();
    // On touch, a message shows what can be done with it once tapped; before
    // that its actions are out of sight but a screen reader finds them.
    const makeTask = posted.getByRole('button', { name: '转为任务' });
    const actions = posted.locator('.message-actions');
    await expect(posted).toMatchAriaSnapshot(`
      - button "回复"
      - button "转为任务"
    `);
    expect(await actions.boundingBox()).toMatchObject({ width: 1, height: 1 });
    await posted.getByText('Ship the release notes').tap();
    await expect(makeTask).toBeVisible();
    expect((await actions.boundingBox())?.width).toBeGreaterThan(44);
    // A long conversation scrolls behind the composer, which sits on the
    // bottom edge over paper: no message shows below it.
    await seedMessages(hub.database, state.channel.id, state.human.id, 40);
    await readAgain(page);
    await expect(
      page.getByRole('list', { name: '频道消息' }).getByText('Message 40'),
    ).toBeVisible();
    await page.evaluate(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight / 2 });
    });
    const edge = await page.evaluate(() => {
      const composer = document.querySelector('.composer');
      const under = document.elementFromPoint(
        window.innerWidth / 2,
        window.innerHeight - 2,
      );
      return {
        bottom: composer?.getBoundingClientRect().bottom,
        masked: under !== null && composer?.contains(under) === true,
      };
    });
    expect(edge).toEqual({ bottom: 812, masked: true });
  } finally {
    await phone.close();
  }
});

test('said once: a topic’s messages carry no tag for it, and one place is current at a time', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  await page.getByRole('button', { name: '新建话题' }).click();
  await page.getByLabel('话题名称').fill('Billing');
  await page.getByLabel('话题名称').press('Enter');
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('In the topic');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const posted = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'In the topic' });
  await expect(posted).toBeVisible();
  await expect(posted.getByText('Billing', { exact: true })).toHaveCount(0);
  const topics = page.getByRole('list', { name: '话题' });
  const billing = topics.getByRole('button', { name: 'Billing', exact: true });
  const channelRow = page
    .getByRole('navigation', { name: '频道' })
    .getByRole('link', { name: /^general( |$)/ });
  const fill = (row: typeof billing) =>
    row.evaluate((el) => getComputedStyle(el).backgroundColor);
  const clear = 'rgba(0, 0, 0, 0)';
  // In a topic, the topic carries the fill and its channel only its ink.
  await expect(billing).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(0, 0);
  await expect.poll(() => fill(billing)).not.toBe(clear);
  await expect.poll(() => fill(channelRow)).toBe(clear);
  // "All" is the whole channel: the channel row is the place, never "All".
  const all = topics.getByRole('button', { name: '全部', exact: true });
  await all.click();
  await expect(posted.getByText('Billing', { exact: true })).toBeVisible();
  await expect(all).not.toHaveAttribute('aria-pressed');
  await expect(billing).toHaveAttribute('aria-pressed', 'false');
  await expect(channelRow).toHaveAttribute('aria-current', 'page');
  await page.mouse.move(0, 0);
  await expect.poll(() => fill(channelRow)).not.toBe(clear);
  await expect.poll(() => fill(all)).toBe(clear);
  // The fill is a row's, not a card's: same height, no border.
  const box = await channelRow.evaluate((el) => ({
    border: getComputedStyle(el).borderTopColor,
    height: el.getBoundingClientRect().height,
  }));
  expect(box.border).toBe(clear);
  // On Team the place is Team: neither the channel nor a topic is current,
  // and the row keeps its height.
  await billing.click();
  await page.getByRole('link', { name: '成员', exact: true }).click();
  await expect(billing).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.locator('nav[aria-label="频道"] [aria-current="page"]'),
  ).toHaveCount(0);
  expect(
    await channelRow.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(box.height);
  await page.getByRole('link', { name: '看板', exact: true }).click();
  await expect(billing).toHaveAttribute('aria-pressed', 'true');
});

test('a fenced code block is one block, not a box around every line', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer
    .getByLabel('消息', { exact: true })
    .fill(
      'Run this:\n```\nnpm ci\nnpm run build\nnpm start\n```\nthen `npm test`',
    );
  await composer.getByRole('button', { name: '发送消息' }).click();
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Run this:' });
  const block = message.locator('pre');
  await expect(block).toHaveText('npm ci\nnpm run build\nnpm start');
  // The block has the one sunken background; the code in it is a single
  // box with no border, background or padding of its own.
  const shape = await block.evaluate((pre) => {
    const code = pre.querySelector('code');
    if (!code) throw new Error('no code in the block');
    const style = getComputedStyle(code);
    return {
      pre: getComputedStyle(pre).backgroundColor,
      boxes: code.getClientRects().length,
      border: style.borderTopWidth,
      background: style.backgroundColor,
      padding: style.paddingLeft,
    };
  });
  expect(shape.pre).not.toBe('rgba(0, 0, 0, 0)');
  expect(shape).toMatchObject({
    boxes: 1,
    border: '0px',
    background: 'rgba(0, 0, 0, 0)',
    padding: '0px',
  });
  // Inline code outside a block keeps its own box.
  const inline = message.locator('p code', { hasText: 'npm test' });
  await expect(inline).toBeVisible();
  expect(
    await inline.evaluate((el) => getComputedStyle(el).borderTopWidth),
  ).toBe('1px');
});

/**
 * Proves any message can be reached: one far older than the workspace's
 * window opens from its address, shown in its conversation, also after a
 * reload; scrolling back reaches the channel's first message; and a
 * message's link is that address.
 */
test('a message far back opens from its address, stays across a reload, and the start is reachable', async ({
  page,
  context,
  hub,
}) => {
  test.setTimeout(90_000);
  const lastCopied = await recordCopies(page);
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  const channelId = state.channel.id;
  // Older history than the window holds: 260 messages, oldest first.
  const ids = Array.from({ length: 260 }, () => randomUUID());
  const sql = rawDatabase(hub.database);
  try {
    for (const [n, id] of ids.entries())
      await sql
        .prepare(
          'INSERT INTO messages (id, channel_id, topic_id, author, created_at, body) VALUES (?, ?, NULL, ?, ?, ?)',
        )
        .run(
          id,
          channelId,
          JSON.stringify({ kind: 'human', humanId: state.human.id }),
          new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
          'History ' + String(n),
        );
  } finally {
    await sql.close();
  }
  const row = (n: number) => page.locator('#message-' + String(ids[n]));
  // Its address opens the channel at it, however far back.
  await page.goto(
    `${hub.origin}/?channel=${channelId}&message=${String(ids[3])}`,
  );
  await expect(row(3)).toBeInViewport({ timeout: 20_000 });
  await expect(row(3)).toContainText('History 3');
  await page.reload();
  await expect(row(3)).toBeInViewport({ timeout: 20_000 });
  // Scrolling back reaches the channel's very first message.
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, -20_000);
        return row(0).count();
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  await expect(row(0)).toContainText('History 0');
  // It is the beginning: nothing above it.
  await expect(
    page.locator('.messages > li[id^="message-"]').first(),
  ).toHaveAttribute('id', 'message-' + String(ids[0]));
  // A message's link is that address.
  await row(3).hover();
  await row(3)
    .locator('.message-actions')
    .getByRole('button', { name: '复制链接' })
    .click();
  expect(await lastCopied()).toBe(
    `${hub.origin}/?channel=${channelId}&message=${String(ids[3])}`,
  );
});

/**
 * Proves a person can reply to a message: 回复 puts it above the field, the
 * reply carries it and quotes it, and the quote opens it.
 */
test('a reply names the message it answers, quotes it, and the quote opens it', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  const say = async (text: string) => {
    await field.fill(text);
    await composer.getByRole('button', { name: '发送消息' }).click();
  };
  const item = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text })
      .first();
  await say('The original question');
  await expect(item('The original question')).toBeVisible();
  await say('Something else in between');
  await expect(item('Something else in between')).toBeVisible();
  await item('The original question').hover();
  await item('The original question')
    .locator('.message-actions')
    .getByRole('button', { name: '回复' })
    .click();
  await expect(composer.locator('.composer-reply')).toContainText(
    'The original question',
  );
  await expect(field).toBeFocused();
  await say('The answer');
  await expect(composer.locator('.composer-reply')).toHaveCount(0);
  const answer = item('The answer');
  const quote = answer.locator('button.reply-to');
  await expect(quote).toContainText('The original question');
  const source = (
    await snapshot(context.request, hub.origin)
  ).messages.items.find((m) => m.body === 'The original question');
  await expect
    .poll(
      async () =>
        (await snapshot(context.request, hub.origin)).messages.items.find(
          (m) => m.body === 'The answer',
        )?.sourceMessageId,
    )
    .toBe(source?.id);
  await quote.click();
  await expect(item('The original question')).toBeInViewport();
});

/**
 * Proves a reaction is added from a message's actions, shows under it as
 * yours, and pressing it takes it back.
 */
test('a reaction is added from a message’s actions and taken back from its pill', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('Shall we ship?');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Shall we ship?' });
  await message.hover();
  await message
    .locator('.message-actions')
    .getByRole('button', { name: '回应' })
    .click();
  await page.getByRole('menuitemcheckbox', { name: '👍' }).click();
  const pill = message
    .getByRole('list', { name: '回应' })
    .getByRole('button', { name: /^👍 1/ });
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await pill.click();
  await expect(message.getByRole('list', { name: '回应' })).toHaveCount(0);
});

/**
 * Proves a message is pinned from its actions, the channel's 置顶 view lists
 * it and opens it, and it is unpinned there.
 */
test('a message is pinned, listed in the 置顶 view, opened from it, and unpinned', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('We ship on Friday');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'We ship on Friday' });
  // No pins, no view for them.
  await expect(page.getByRole('link', { name: '置顶' })).toHaveCount(0);
  await message.hover();
  await message
    .locator('.message-actions')
    .getByRole('button', { name: '置顶', exact: true })
    .click();
  await page.getByRole('link', { name: '置顶' }).click();
  const pins = page.getByRole('list', { name: '置顶的消息' });
  await expect(pins).toContainText('We ship on Friday');
  await pins.getByRole('button', { name: /We ship on Friday/ }).click();
  await expect(message).toBeInViewport();
  await page.getByRole('link', { name: '置顶' }).click();
  await pins.getByRole('button', { name: '取消置顶' }).click();
  await expect(page.getByText('这个频道还没有置顶的消息。')).toBeVisible();
});

/**
 * Proves a person edits their message in place (Esc leaves it as it was),
 * it then says 已编辑, and withdrawing it, asked twice, leaves only that it
 * was withdrawn.
 */
test('a person edits their message in place and withdraws it', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  await composer.getByLabel('消息', { exact: true }).fill('Ship on Monday');
  await composer.getByRole('button', { name: '发送消息' }).click();
  const list = page.getByRole('list', { name: '频道消息' });
  const sent = list.getByRole('listitem').filter({ hasText: 'Ship on Monday' });
  await expect(sent).not.toHaveAttribute('data-pending', /.+/);
  // By its place, not its words: they change as it is edited.
  const message = page.locator(
    '#' + ((await sent.getAttribute('id')) ?? 'missing'),
  );
  const actions = message.locator('.message-actions');
  await message.hover();
  await actions.getByRole('button', { name: '编辑' }).click();
  const field = message.getByRole('textbox', { name: '编辑消息' });
  await expect(field).toBeFocused();
  await field.fill('Ship on Sunday');
  await field.press('Escape');
  await expect(message.locator('.message-text')).toHaveText('Ship on Monday');
  await message.hover();
  await actions.getByRole('button', { name: '编辑' }).click();
  await field.fill('Ship on Tuesday');
  await field.press('Enter');
  await expect(message.locator('.message-text')).toHaveText('Ship on Tuesday');
  await expect(message.locator('.message-edited')).toHaveText('已编辑');
  await message.hover();
  await actions.getByRole('button', { name: '撤回' }).click();
  await actions.getByRole('button', { name: '确认撤回' }).click();
  await expect(list.getByText('这条消息已撤回')).toBeVisible();
  await expect(list).not.toContainText('Ship on Tuesday');
});

/**
 * Proves a code block and a message each copy as written: the code without
 * the button's word, the message as its Markdown.
 */
test('a code block and a message each copy as written', async ({
  page,
  hub,
}) => {
  const lastCopied = await recordCopies(page);
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const body = 'Run **this**:\n```sh\nnpm ci\nnpm start\n```';
  await composer.getByLabel('消息', { exact: true }).fill(body);
  await composer.getByRole('button', { name: '发送消息' }).click();
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Run' });
  const block = message.locator('.code-block');
  await block.hover();
  // By its place: its name becomes 已复制 once pressed.
  const copyCode = block.locator('.code-copy');
  await copyCode.click();
  await expect(copyCode).toHaveText('已复制');
  expect(await lastCopied()).toBe('npm ci\nnpm start');
  // 已复制 is also said as a status, from a region that was there before,
  // and the button stays in sight while it says it, wherever the pointer is.
  await expect(block.getByRole('status')).toHaveText('已复制');
  await page.mouse.move(0, 0);
  await expect(copyCode).toHaveCSS('opacity', '1');
  // A wide block scrolls by keyboard: Tab reaches it, as it does a table.
  const code = block.getByRole('region', { name: '代码' });
  await copyCode.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(code).toBeFocused();
  await message.hover();
  await message
    .locator('.message-actions')
    .getByRole('button', { name: '复制', exact: true })
    .click();
  expect(await lastCopied()).toBe(body);
});

test('a pasted image and a chosen file go with a message: the image as it is, the file as a row that downloads', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  // A file chosen with the paperclip, and an image pasted into the text.
  await composer.locator('input[type="file"]').setInputFiles({
    name: 'build.log',
    mimeType: 'text/plain',
    buffer: Buffer.from('line 1\nline 2\n'),
  });
  await composer.getByLabel('消息', { exact: true }).evaluate((field) => {
    const pixel = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const files = new DataTransfer();
    files.items.add(new File([pixel], 'pixel.png', { type: 'image/png' }));
    field.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: files, bubbles: true }),
    );
  });
  const attached = composer.getByRole('list', { name: '附件' });
  await expect(attached.getByRole('listitem')).toHaveCount(2);
  // Files alone are enough to send, once they are all there.
  const send = composer.getByRole('button', { name: '发送消息' });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(attached).toHaveCount(0);
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('list', { name: '图片' }) })
    .last();
  const image = message.getByRole('img', { name: 'pixel.png' });
  await expect(image).toBeVisible();
  // It holds its place: its own pixels, given before it loads.
  expect(await image.getAttribute('width')).toBe('1');
  expect(
    await image.evaluate((img) =>
      img instanceof HTMLImageElement ? img.naturalWidth : 0,
    ),
  ).toBe(1);
  const row = message.getByRole('link', { name: /build\.log/ });
  await expect(row).toHaveAttribute('download', 'build.log');
  await expect(row).toContainText('14 B');
  // On the message's text edge.
  const edge = async (locator: typeof row) =>
    Math.round((await locator.boundingBox())?.x ?? -1);
  expect(await edge(image)).toBe(await edge(message.locator('.message-body')));
  expect(await edge(row)).toBe(await edge(image));
});

/**
 * Proves the keyboard sends no sooner than Send: while a file is still
 * uploading, ⌘/Ctrl+Enter leaves the message and the file in the composer.
 */
test('⌘/Ctrl+Enter waits for a file still uploading, as Send does', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/attachments/uploads', async (route) => {
    await held;
    await route.continue();
  });
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const field = composer.getByLabel('消息', { exact: true });
  await field.fill('The log is attached');
  await composer.locator('input[type="file"]').setInputFiles({
    name: 'run.log',
    mimeType: 'text/plain',
    buffer: Buffer.from('ok\n'),
  });
  const attached = composer.getByRole('list', { name: '附件' });
  await expect(attached.getByRole('listitem')).toHaveCount(1);
  await field.press('ControlOrMeta+Enter');
  const messages = page.getByRole('list', { name: '频道消息' });
  await expect(field).toHaveValue('The log is attached');
  await expect(attached.getByRole('listitem')).toHaveCount(1);
  await expect(messages.getByText('The log is attached')).toHaveCount(0);
  // Once it is up, the same key sends both.
  release();
  await expect(
    composer.getByRole('button', { name: '发送消息' }),
  ).toBeEnabled();
  await field.press('ControlOrMeta+Enter');
  const sent = messages
    .getByRole('listitem')
    .filter({ hasText: 'The log is attached' });
  await expect(sent.getByRole('link', { name: /run\.log/ })).toBeVisible();
});

test('one author’s run of messages is one group: the face and name once, each time on hover, a new day says so', async ({
  page,
  context,
  hub,
}) => {
  await signIn(page, hub);
  const state = await snapshot(context.request, hub.origin);
  if (!state.channel) throw new Error('Local channel missing');
  // Something said yesterday, so today opens under its own date.
  const sql = rawDatabase(hub.database);
  try {
    await sql
      .prepare(
        `INSERT INTO messages (id, channel_id, topic_id, author, created_at, body)
         VALUES (gen_random_uuid()::text, ?, NULL, ?,
           to_char((now() AT TIME ZONE 'utc') - interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'Said yesterday')`,
      )
      .run(
        state.channel.id,
        JSON.stringify({ kind: 'human', humanId: state.human.id }),
      );
  } finally {
    await sql.close();
  }
  await page.reload();
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const messages = page.getByRole('list', { name: '频道消息' });
  const item = (text: string) =>
    messages.getByRole('listitem').filter({ hasText: text });
  // Each is sent once the one before has arrived.
  for (const body of ['First of a group', 'Second of a group']) {
    await composer.getByLabel('消息', { exact: true }).fill(body);
    await composer.getByRole('button', { name: '发送消息' }).click();
    await expect(item(body)).toBeVisible();
    await expect(item(body)).not.toHaveAttribute('data-pending');
  }
  // The days are separators, in order; yesterday's message is not grouped
  // with today's.
  const days = messages.getByRole('separator');
  await expect(days.filter({ hasText: '昨天' })).toHaveCount(1);
  await expect(days.filter({ hasText: '今天' })).toHaveCount(1);
  await expect(item('First of a group').locator('header')).toHaveCount(1);
  await expect(item('First of a group').locator('.avatar')).toHaveCount(1);
  // The second message sits under the first: no face, no name line…
  const second = item('Second of a group');
  await expect(second.locator('header')).toHaveCount(0);
  await expect(second.locator('.avatar')).toHaveCount(0);
  // …and its text starts on the first one's text edge.
  const edge = async (text: string) =>
    (await messages.getByText(text, { exact: true }).boundingBox())?.x;
  expect(await edge('Second of a group')).toBe(await edge('First of a group'));
  // Its time is always there for a screen reader, with its author, and
  // shown only while the message is pointed at.
  const time = second.locator('time');
  await expect(time).toHaveAttribute('datetime', /T/);
  const author = await item('First of a group')
    .locator('header strong')
    .textContent();
  expect(author).toBeTruthy();
  await expect(time).toContainText(author ?? '');
  await page.mouse.move(0, 0);
  await expect
    .poll(() => time.evaluate((el) => getComputedStyle(el).opacity))
    .toBe('0');
  await second.hover();
  await expect
    .poll(() => time.evaluate((el) => getComputedStyle(el).opacity))
    .toBe('1');
});

/**
 * Proves the Markdown agents write lays out inside its message: a nested
 * list, a task list and a wide table, with no sideways page scroll.
 */
test('a reply with a nested list, a task list and a wide table lays out inside its message', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const wide = Array.from({ length: 12 }, (_, i) => `column ${String(i)}`);
  await composer
    .getByLabel('消息', { exact: true })
    .fill(
      [
        'Plan:',
        '',
        '- ship',
        '  - **build**',
        '  - ~~old step~~',
        '',
        '- [x] tests pass',
        '- [ ] docs updated',
        '',
        '| ' + wide.join(' | ') + ' |',
        '| ' + wide.map(() => '-').join(' | ') + ' |',
        '| ' + wide.map((_, i) => String(i)).join(' | ') + ' |',
      ].join('\n'),
    );
  await composer.getByRole('button', { name: '发送消息' }).click();
  const message = page
    .getByRole('list', { name: '频道消息' })
    .getByRole('listitem')
    .filter({ hasText: 'Plan:' })
    .first();
  const body = message.locator('.message-text');
  await expect(body.locator('ul ul li')).toHaveCount(2);
  await expect(body.locator('del')).toHaveText('old step');
  const boxes = body.getByRole('checkbox');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.first()).toBeChecked();
  await expect(boxes.first()).toBeDisabled();
  const table = body.getByRole('region', { name: '表格' });
  await expect(table.getByRole('cell', { name: '11' })).toHaveCount(1);
  const [row, region] = await Promise.all([
    message.boundingBox(),
    table.boundingBox(),
  ]);
  expect(row && region && region.x + region.width <= row.x + row.width).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

/**
 * Proves code is highlighted in its declared language, and the highlighter
 * loads only once a message has such a block.
 */
test('code in a declared language is highlighted, and the highlighter loads only for it', async ({
  page,
  hub,
}) => {
  const loaded: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/assets/lowlight-')) loaded.push(request.url());
  });
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const say = async (body: string) => {
    await composer.getByLabel('消息', { exact: true }).fill(body);
    await composer.getByRole('button', { name: '发送消息' }).click();
  };
  const item = (text: string) =>
    page
      .getByRole('list', { name: '频道消息' })
      .getByRole('listitem')
      .filter({ hasText: text });
  await say('Plain words, and `inline` code only');
  await expect(item('Plain words')).toBeVisible();
  expect(loaded).toHaveLength(0);
  await say('Typed:\n```ts\nconst answer: number = 42; // the answer\n```');
  const code = item('Typed:').locator('pre code.language-ts');
  await expect(code.locator('.hljs-keyword').first()).toHaveText('const');
  await expect(code.locator('.hljs-number')).toHaveText('42');
  await expect(code.locator('.hljs-comment')).toHaveText('// the answer');
  expect(loaded.length).toBeGreaterThan(0);
  // A language it doesn't know stays plain code.
  await say('Odd:\n```nosuchlang\nkeep me\n```');
  const odd = item('Odd:').locator('pre code.language-nosuchlang');
  await expect(odd).toHaveText('keep me');
  await expect(odd.locator('span')).toHaveCount(0);
});

test('a mermaid block is drawn as its diagram, and one that can’t be drawn stays its code', async ({
  page,
  hub,
}) => {
  await signIn(page, hub);
  const composer = page.getByRole('form', { name: '给团队发消息' });
  const say = async (body: string) => {
    await composer.getByLabel('消息', { exact: true }).fill(body);
    await composer.getByRole('button', { name: '发送消息' }).click();
  };
  const messages = page.getByRole('list', { name: '频道消息' });
  const item = (text: string) =>
    messages.getByRole('listitem').filter({ hasText: text });
  // A label's line break (`<br/>`, which Mermaid writes as HTML) is drawn too.
  await say(
    'Drawn:\n```mermaid\nflowchart LR\n  A["Proposed<br/>by Ada"] --> B[Done]\n```',
  );
  // An image, drawn from an SVG that runs nothing, where the code was.
  const drawing = item('Drawn:').getByRole('img', { name: '图表' });
  await expect(drawing).toBeVisible();
  await expect(drawing).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect
    .poll(() => drawing.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(item('Drawn:').locator('pre')).toHaveCount(0);
  // A block that can't be drawn is shown as the code it is, and says
  // nothing else; a fence keeps its language either way.
  await say('Broken:\n```mermaid\nflowchart LR\n  A[never closed -->\n```');
  const code = item('Broken:').locator('pre code.language-mermaid');
  await expect(code).toHaveText('flowchart LR\n  A[never closed -->');
  await expect(item('Broken:').getByRole('img')).toHaveCount(0);
  await expect(item('Broken:')).not.toContainText(/error/i);
  await say('Typed:\n```ts\nconst x = 1;\n```');
  await expect(item('Typed:').locator('pre code.language-ts')).toHaveText(
    'const x = 1;',
  );
});

test('a new team is guided through its first steps, each with the control that does it', async ({
  page,
  hub,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, hub);
  const guide = page.getByRole('region', { name: '开始使用' });
  await expect(guide).toBeVisible();
  // Nothing is done yet: three steps, the first one's control adds an agent.
  const steps = guide.getByRole('listitem');
  await expect(steps).toHaveCount(3);
  await expect(steps.first()).not.toContainText('已完成');
  await guide.getByRole('button', { name: '添加', exact: true }).click();
  await expect(
    page.getByRole('link', { name: '成员', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  // It sits in the conversation's column, on its text edge.
  await page.getByRole('link', { name: '聊天', exact: true }).click();
  const [box, list] = await Promise.all([
    guide.boundingBox(),
    page.getByRole('list', { name: '频道消息' }).boundingBox(),
  ]);
  expect(Math.round(box?.x ?? -1)).toBe(Math.round(list?.x ?? -2));
});
