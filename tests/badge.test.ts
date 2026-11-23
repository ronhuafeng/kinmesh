import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeOf } from '../web/inbox/attention.js';

/** The app's badge follows one rule, whatever changed last. */
await test('the badge counts decisions; else a dot while anything is unread; else nothing', () => {
  assert.equal(badgeOf(2, false), 2);
  // Decisions waiting win over unread: the count shows, not a dot.
  assert.equal(badgeOf(2, true), 2);
  assert.equal(badgeOf(0, true), true);
  assert.equal(badgeOf(0, false), null);
});
