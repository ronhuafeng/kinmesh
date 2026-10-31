import assert from 'node:assert/strict';
import { Activity } from './proof.js';

/** Public MCP cursor reads only. Complete large Team replies without mixing revisions. */
export async function readActivity(
  call: (input: Record<string, unknown>) => Promise<unknown>,
  threadId: string,
): Promise<Activity> {
  const items: Activity['items'] = [];
  let after: number | undefined;
  let total = 0;
  for (let page = 0; page < 8; page++) {
    const activity = Activity.parse(
      await call({
        threadId,
        view: 'activity',
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: 50000,
        ...(after === undefined ? {} : { afterPosition: after }),
      }),
    );
    assert.equal(activity.thread.threadId, threadId);
    for (const initial of activity.items) {
      let item = initial;
      let text = initial.text ?? '';
      const team =
        initial.type === 'dynamic_tool' &&
        /"toolName"\s*:\s*"kinmesh(?:\.|__)/.test(text);
      if (team && initial.status === 'completed' && initial.textTruncated) {
        assert.ok(initial.updatedAt, 'NATIVE_ITEM_REVISION_MISSING');
        let offset = 0;
        for (let chunk = 0; item.textTruncated && chunk < 8; chunk++) {
          const next = item.nextTextOffset;
          assert.ok(
            next !== undefined &&
              next !== null &&
              item.text !== null &&
              next > offset &&
              next === offset + item.text.length,
            'NATIVE_ITEM_CURSOR_INVALID',
          );
          offset = next;
          const reply = Activity.parse(
            await call({
              threadId,
              view: 'activity',
              itemId: initial.itemId,
              textOffset: offset,
              limit: 1,
              maxCharsPerItem: 50000,
            }),
          );
          assert.equal(reply.thread.threadId, threadId);
          assert.equal(reply.items.length, 1);
          const part = reply.items[0];
          assert.ok(part);
          assert.equal(part.itemId, initial.itemId);
          assert.equal(part.runId, initial.runId);
          assert.equal(part.type, initial.type);
          assert.equal(part.status, initial.status);
          assert.equal(part.updatedAt, initial.updatedAt);
          assert.ok(part.text !== null);
          text += part.text;
          assert.ok(text.length <= 300000, 'NATIVE_ITEM_EVIDENCE_BOUND');
          item = part;
        }
        assert.equal(
          item.textTruncated,
          false,
          'NATIVE_ITEM_EVIDENCE_INCOMPLETE',
        );
        item = { ...initial, text, textTruncated: false, nextTextOffset: null };
      }
      if (team) {
        total += text.length;
        assert.ok(total <= 2000000, 'NATIVE_ACTIVITY_EVIDENCE_BOUND');
      }
      items.push(item);
    }
    if (!activity.hasMore) return { ...activity, items };
    assert.ok(
      activity.nextPosition !== null &&
        (after === undefined || activity.nextPosition > after),
      'NATIVE_ACTIVITY_CURSOR_INVALID',
    );
    after = activity.nextPosition;
  }
  throw new Error('NATIVE_ACTIVITY_EVIDENCE_PAGE_BOUND');
}
