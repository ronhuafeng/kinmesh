import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { everyPage } from '../web/shared/api.js';

/**
 * A list read page by page to its end: a task's whole history shows, not
 * only its first page.
 */
await test('every page of a list is read, following its cursor to the end', async () => {
  const asked: string[] = [];
  const pages: Record<string, unknown> = {
    '/h?limit=100': { items: [1, 2], nextCursor: 'b' },
    '/h?limit=100&cursor=b': { items: [3], nextCursor: 'c' },
    '/h?limit=100&cursor=c': { items: [4], nextCursor: null },
  };
  globalThis.fetch = (input: string | URL | Request) => {
    const path = typeof input === 'string' ? input : '';
    asked.push(path);
    return Promise.resolve(Response.json(pages[path]));
  };
  const items = await everyPage('/h', z.number(), new AbortController().signal);
  assert.deepEqual(items, [1, 2, 3, 4]);
  assert.equal(asked.length, 3);
});
