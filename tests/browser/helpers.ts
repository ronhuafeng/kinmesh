import type { Page, APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import { rawDatabase } from '../raw.js';
import { Grant } from '../../src/domain/agents.js';
import { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { expect } from './fixture.js';
import { agentRow, register, signIn } from './ui.js';
/**
 * Records what the page hands the clipboard: CI's headless browser has no
 * system clipboard to read back, and what a button copies is the point.
 */
export async function recordCopies(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.defineProperty(window, '__copied', { value: copied });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
  });
  return async () =>
    z
      .array(z.string())
      .parse(
        await page.evaluate((): unknown => Reflect.get(window, '__copied')),
      )
      .at(-1);
}
export async function snapshot(request: APIRequestContext, origin: string) {
  const response = await request.get(origin + '/api/workspace');
  expect(response.status()).toBe(200);
  return WorkspaceSnapshot.parse(await response.json());
}
/**
 * Holds every event stream unopened, so what the view shows comes only from
 * reading the workspace, which the test holds or rewrites. Silent streams
 * leave the view to read the workspace itself.
 */
export async function withoutStream(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/events',
    () => undefined,
  );
}
/** The one line that says what is on screen is stale. */
export function staleLine(page: Page) {
  return page.getByRole('status').filter({ hasText: '连不上 Kinmesh' });
}
/** Healthy is silent: no refresh pill and no stale line. */
export async function expectHealthy(page: Page) {
  await expect(
    page.getByRole('status').filter({ hasText: /^正在刷新…$/ }),
  ).toHaveCount(0);
  await expect(staleLine(page)).toHaveCount(0);
}
/** WCAG contrast of an element's text against the surface it sits on. */
export function contrast(page: Page, selector: string) {
  return page.evaluate((target) => {
    const rgba = (color: string) => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('No canvas');
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (color: number[]) => {
      const [r = 0, g = 0, b = 0] = color.slice(0, 3).map((value) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const element = document.querySelector(target);
    if (!element) throw new Error('Nothing matches ' + target);
    // The nearest ancestor that paints an opaque background.
    let surface: number[] | null = null;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const painted = rgba(getComputedStyle(node).backgroundColor);
      if (painted[3] === 255) {
        surface = painted;
        break;
      }
    }
    if (!surface) throw new Error('No surface under ' + target);
    const ink = luminance(rgba(getComputedStyle(element).color));
    const paper = luminance(surface);
    return (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05);
  }, selector);
}
/** A run's state as its row says it. */
export function runState(page: Page, label: string) {
  return page.locator('.run-state').getByText(label, { exact: true });
}
export async function agentGrant(
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

// All fulfilled observations below are local browser mocks, never live native acceptance.
export async function openMockNativeCard(
  page: Page,
  request: APIRequestContext,
  hub: { origin: string },
) {
  // The workspace comes only from reads, which carry the mock origin.
  await withoutStream(page);
  await page.route('**/api/workspace**', async (route) => {
    // A read after the test's hub has stopped is simply lost.
    const response = await route.fetch().catch(() => null);
    if (!response) {
      await route.abort();
      return;
    }
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
  await signIn(page, hub);
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
  await agentRow(page, 'Mock Native Observer').click();
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

/** `count` messages by `humanId` in a channel, "Message 1" oldest, written below the API so a long history needs no rate-limited posts. */
export async function seedMessages(
  database: string,
  channelId: string,
  humanId: string,
  count: number,
) {
  const sql = rawDatabase(database);
  try {
    await sql
      .prepare(
        `INSERT INTO messages (id, channel_id, topic_id, author, created_at, body)
         SELECT gen_random_uuid()::text, ?, NULL, ?,
           to_char((now() AT TIME ZONE 'utc') - make_interval(mins => ? - g), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'Message ' || g
         FROM generate_series(1, ?) AS g ORDER BY g`,
      )
      .run(
        channelId,
        JSON.stringify({ kind: 'human', humanId }),
        count + 10,
        count,
      );
  } finally {
    await sql.close();
  }
}
/** Where a message sits in the viewport, by its exact text. */
export async function topOf(page: Page, text: string) {
  const box = await page
    .getByRole('list', { name: '频道消息' })
    .getByText(text, { exact: true })
    .boundingBox();
  if (!box) throw new Error(text + ' is not on the page');
  return box.y;
}
/**
 * Reads the workspace again the way a network coming back does. Live push
 * is proven by its own tests; a measurement that only needs the new message
 * on screen does not wait on the stream's timing.
 */
export const readAgain = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });
export const atBottom = (page: Page) =>
  page.evaluate(
    () =>
      window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 48,
  );

/**
 * Whether taps up to 21 px above, below, left and right of an element's
 * centre land on it: a 44 px target, however small it is drawn.
 */
export function takesTaps(page: Page, selector: string) {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) throw new Error('Nothing matches ' + target);
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return [
      [x, y - 21],
      [x, y + 21],
      [x - 21, y],
      [x + 21, y],
    ].map(([px = 0, py = 0]) => {
      const hit = document.elementFromPoint(px, py);
      return hit !== null && (hit === element || element.contains(hit));
    });
  }, selector);
}
