import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliveryText } from '../web/deliveries.js';
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
});

await test('every delivery state reads as a plain sentence about the agent', () => {
  const cases: [DeliveryView['state'], string, boolean, RegExp][] = [
    ['ready', 'enqueued', true, /^Ada will pick this up · just now$/],
    ['ready', 'enqueued', false, /^Ada isn’t connected/],
    ['ready', 'temporarily-unavailable', true, /retry when T3 is reachable/],
    ['ready', 'operator-resume', true, /will pick this up/],
    ['waiting', 'execution-active', true, /^Ada is working on it$/],
    ['waiting', 'human-or-approval-wait', true, /waiting for an approval/],
    ['waiting', 'assistant-result-unavailable', true, /working on it/],
    ['uncertain', 'native-launch-uncertain', true, /^Checking whether Ada/],
    ['acked', 'assistant-result-published', true, /^Ada replied$/],
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
    ['expired', 'undispatched-expiry', true, /never picked this up/],
    ['expired', 'something-new', true, /request expired/],
  ];
  for (const [state, reason, connected, expected] of cases) {
    const { text } = deliveryText(delivery(state, reason), 'Ada', connected);
    assert.match(text, expected, `${state}/${reason}`);
    // No machine vocabulary leaks into the sentence.
    assert.doesNotMatch(text, /acked|enqueued|uncertain|delivery|inbox/i);
  }
});
