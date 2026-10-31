import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readActivity } from './live/activity.js';
import type { Activity } from './live/proof.js';

const item: Activity['items'][number] = {
  itemId: 'item',
  runId: 'run',
  type: 'dynamic_tool',
  status: 'completed',
  updatedAt: '2026-10-31T09:00:00Z',
  text: '{"toolName":"kinmesh__team_messages_read",'.padEnd(50000),
  textTruncated: true,
  nextTextOffset: 50000,
};
function page(items: Activity['items'], hasMore = false): Activity {
  return {
    thread: {
      threadId: 'thread',
      projectId: 'project',
      status: 'completed',
      latestRunId: 'run',
      activeRunId: null,
      pendingRequestCount: 0,
      providerInstanceId: 'provider',
      model: 'model',
    },
    recentRuns: [],
    items,
    nextPosition: 10,
    hasMore,
  };
}
const tail = {
  ...item,
  text: '"output":{}}',
  textTruncated: false,
  nextTextOffset: null,
};

await test('LIVE ORACLE FIXTURE: public item cursor completes a Team reply and preserves activity pagination', async () => {
  const calls: Record<string, unknown>[] = [];
  const replies = [page([item], true), page([tail]), page([])];
  const activity = await readActivity((input) => {
    calls.push(input);
    return Promise.resolve(replies.shift());
  }, 'thread');
  assert.equal(activity.items.length, 1);
  assert.equal(activity.items[0]?.text, (item.text ?? '') + tail.text);
  assert.equal(activity.items[0].textTruncated, false);
  assert.equal(calls[1]?.itemId, 'item');
  assert.equal(calls[1].textOffset, 50000);
  assert.equal(calls[2]?.afterPosition, 10);
  assert.equal(calls[2].itemId, undefined);
});

await test('LIVE ORACLE FIXTURE: changed item identity or revision cannot be spliced into native evidence', async () => {
  for (const changed of [
    { ...tail, itemId: 'other' },
    { ...tail, runId: 'other' },
    { ...tail, updatedAt: 'later' },
    { ...tail, status: 'running' },
  ]) {
    const replies = [page([item]), page([changed])];
    await assert.rejects(
      readActivity(() => Promise.resolve(replies.shift()), 'thread'),
    );
  }
});

await test('LIVE ORACLE FIXTURE: absent, stalled and excessive native cursors fail closed', async () => {
  await assert.rejects(
    readActivity(
      () => Promise.resolve(page([{ ...item, nextTextOffset: null }])),
      'thread',
    ),
    /NATIVE_ITEM_CURSOR_INVALID/,
  );
  await assert.rejects(
    readActivity(() => Promise.resolve(page([item])), 'thread'),
    /NATIVE_ITEM_CURSOR_INVALID/,
  );
  let calls = 0;
  await assert.rejects(
    readActivity((input) => {
      calls++;
      return Promise.resolve(
        page([
          calls === 1
            ? item
            : {
                ...item,
                text: 'x',
                nextTextOffset: Number(input.textOffset) + 1,
              },
        ]),
      );
    }, 'thread'),
    /NATIVE_ITEM_EVIDENCE_INCOMPLETE/,
  );
  assert.equal(calls, 9);
});
