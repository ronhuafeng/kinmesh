import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, dayLabel } from '../web/shared/format.js';

/**
 * Proves a relative time counts the whole units that have passed, never
 * rounding up: an hour and a half is still an hour, a day and a half a day.
 */
await test('relative times floor', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  const before = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();
  assert.equal(ago(before(0.5), now), '刚刚');
  assert.equal(ago(before(59.9), now), '59 分钟前');
  assert.equal(ago(before(90), now), '1 小时前');
  assert.equal(ago(before(23 * 60 + 59), now), '23 小时前');
  assert.equal(ago(before(36 * 60), now), '1 天前');
  // A clock a little behind what it reads says 刚刚, never a negative time.
  assert.equal(ago(before(-1), now), '刚刚');
});

/** Proves a day is named against the day it is given, not the time it is read. */
await test('a day is named against the given day', () => {
  const evening = new Date(2026, 10, 26, 23, 59);
  const at = evening.toISOString();
  assert.equal(dayLabel(at, new Date(2026, 10, 26)), '今天');
  assert.equal(dayLabel(at, new Date(2026, 10, 27)), '昨天');
  assert.match(dayLabel(at, new Date(2026, 10, 28)), /^11月26日/);
});
