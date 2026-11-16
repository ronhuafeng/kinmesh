import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliveryText, took } from '../web/deliveries.js';
import type { DeliveryView } from '../web/deliveries.js';
import { AgentId } from '../src/domain/contracts.js';

const delivery = (
  state: DeliveryView['state'],
  reason: string,
): DeliveryView => ({
  id: randomUUID(),
  agentId: AgentId.parse(randomUUID()),
  messageId: randomUUID(),
  taskId: null,
  state,
  reason,
  queuedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  resultMessageId: null,
  stopRequested: false,
});

await test('every delivery state reads as a plain sentence about the agent', () => {
  const cases: [DeliveryView['state'], string, boolean, RegExp][] = [
    ['ready', 'enqueued', true, /^Ada will pick this up · just now$/],
    ['ready', 'enqueued', false, /^Ada isn’t connected/],
    ['ready', 'temporarily-unavailable', true, /retry when T3 is reachable/],
    ['ready', 'operator-resume', true, /will pick this up/],
    [
      'ready',
      'sign-in-expired',
      true,
      /^Ada will go on once T3 is reconnected$/,
    ],
    ['waiting', 'execution-active', true, /^Ada is working on it$/],
    ['waiting', 'human-or-approval-wait', true, /waiting for an approval/],
    ['waiting', 'assistant-result-unavailable', true, /working on it/],
    ['uncertain', 'native-launch-uncertain', true, /^Checking whether Ada/],
    ['uncertain', 'native-launch-pending', true, /^Ada is working on it$/],
    [
      'acked',
      'assistant-result-published',
      true,
      /^Ada replied in under a minute$/,
    ],
    ['blocked', 'authority-or-contract-blocked', true, /^Ada is stuck/],
    ['blocked', 'agent-disabled', true, /^Ada is disabled/],
    ['blocked', 'credential-invalid', true, /^Ada’s credential was revoked/],
    ['blocked', 'not-in-channel', true, /^Ada was removed from the channel/],
    ['blocked', 'not-assigned', true, /no longer assigned to Ada/],
    [
      'blocked',
      'native-access',
      true,
      /^T3 refused Ada’s access: reconnect T3/,
    ],
    ['blocked', 'native-incompatible', true, /model isn’t available in T3/],
    [
      'blocked',
      'native-unreadable',
      true,
      /^Kinmesh can’t read what T3 returned for Ada: update Kinmesh$/,
    ],
    [
      'blocked',
      'authority-changed',
      true,
      /^Ada’s T3 access changed while this ran.*ask again$/,
    ],
    [
      'blocked',
      'environment-changed',
      true,
      /environment Ada was connected to: connect Ada again/,
    ],
    ['expired', 'undispatched-expiry', true, /never picked this up/],
    ['expired', 'stopped', true, /^Stopped before Ada started$/],
    ['expired', 'something-new', true, /request expired/],
  ];
  for (const [state, reason, connected, expected] of cases) {
    const { text } = deliveryText(delivery(state, reason), 'Ada', connected);
    assert.match(text, expected, `${state}/${reason}`);
    // No machine vocabulary leaks into the sentence.
    assert.doesNotMatch(text, /acked|enqueued|uncertain|delivery|inbox/i);
  }
});

await test('a delivery a person asked to stop is stopping until it ends', () => {
  for (const state of ['ready', 'waiting', 'uncertain'] as const)
    assert.equal(
      deliveryText(
        { ...delivery(state, 'stop-requested'), stopRequested: true },
        'Ada',
        true,
      ).text,
      'Ada is stopping',
    );
  // Once ended, it says how.
  assert.match(
    deliveryText(
      {
        ...delivery('acked', 'native-terminal-notice-published'),
        stopRequested: true,
      },
      'Ada',
      true,
    ).text,
    /^Ada replied/,
  );
});

await test('a reply says how long it took', () => {
  assert.equal(
    took('2026-10-31T11:00:00Z', '2026-10-31T11:00:40Z'),
    'in under a minute',
  );
  assert.equal(
    took('2026-10-31T11:00:00Z', '2026-10-31T11:07:00Z'),
    'after 7 min',
  );
  assert.equal(
    took('2026-10-31T11:00:00Z', '2026-10-31T12:11:00Z'),
    'after 1 h 11 min',
  );
  assert.equal(
    took('2026-10-31T11:00:00Z', '2026-10-31T13:00:00Z'),
    'after 2 h',
  );
});
