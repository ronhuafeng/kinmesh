import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliveryText, stoppable, took } from '../web/deliveries.js';
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
    ['ready', 'enqueued', true, /^Ada 会接手 · 刚刚$/],
    ['ready', 'enqueued', false, /^Ada 离线/],
    ['ready', 'temporarily-unavailable', true, /^T3 可用时 Ada 会重试$/],
    ['ready', 'operator-resume', true, /会接手/],
    ['ready', 'sign-in-expired', true, /^T3 重新连接后 Ada 会继续$/],
    ['waiting', 'execution-active', true, /^Ada 正在处理$/],
    ['waiting', 'human-or-approval-wait', true, /等待 T3 中的批准/],
    ['waiting', 'assistant-result-unavailable', true, /正在处理/],
    ['uncertain', 'native-launch-uncertain', true, /^正在确认 Ada/],
    ['uncertain', 'native-launch-pending', true, /^Ada 正在处理$/],
    [
      'acked',
      'assistant-result-published',
      true,
      /^Ada 已回复（用时不到 1 分钟）$/,
    ],
    ['blocked', 'authority-or-contract-blocked', true, /^Ada 卡住了/],
    ['blocked', 'agent-disabled', true, /^Ada 已停用/],
    ['blocked', 'credential-invalid', true, /^Ada 的凭据已吊销/],
    ['blocked', 'not-in-channel', true, /^Ada 已被移出频道/],
    ['blocked', 'not-assigned', true, /不再分配给 Ada/],
    ['blocked', 'native-access', true, /^T3 拒绝了 Ada 的访问：请重新连接 T3/],
    ['blocked', 'native-incompatible', true, /模型在 T3 中不可用/],
    [
      'blocked',
      'native-unreadable',
      true,
      /^Ada 的结果无法显示：请更新 Kinmesh$/,
    ],
    [
      'blocked',
      'authority-changed',
      true,
      /^Ada 的 T3 权限在运行中变了.*请重新提问$/,
    ],
    [
      'blocked',
      'environment-changed',
      true,
      /Ada 当初连接的环境：请重新连接 Ada/,
    ],
    ['expired', 'undispatched-expiry', true, /一直没有接手/],
    ['expired', 'stopped', true, /^Ada 开始前已停止$/],
    ['expired', 'authority-changed', true, /^Ada 的 T3 权限变了，已停止$/],
    ['expired', 'something-new', true, /请求已过期/],
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
      'Ada 正在停止',
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
    /^Ada 已回复/,
  );
});

await test('Stop is offered until a delivery ends or is stopping, and for one whose T3 access is gone', () => {
  for (const state of ['ready', 'waiting', 'uncertain'] as const) {
    assert.equal(stoppable(delivery(state, 'enqueued')), true);
    assert.equal(
      stoppable({ ...delivery(state, 'stop-requested'), stopRequested: true }),
      false,
    );
  }
  for (const [state, reason] of [
    ['acked', 'assistant-result-published'],
    ['expired', 'stopped'],
    ['expired', 'authority-changed'],
    ['blocked', 'native-unreadable'],
  ] as const)
    assert.equal(stoppable(delivery(state, reason)), false, reason);
  // Its run can't be reached, so ending it asks nothing of T3, even after
  // a stop was asked for before its access changed.
  const unreachable = delivery('blocked', 'authority-changed');
  assert.equal(stoppable(unreachable), true);
  assert.equal(stoppable({ ...unreachable, stopRequested: true }), true);
  assert.match(
    deliveryText({ ...unreachable, stopRequested: true }, 'Ada', true).text,
    /^Ada 的 T3 权限在运行中变了/,
  );
});

await test('a reply says how long it took', () => {
  assert.equal(
    took('2026-10-31T11:00:00Z', '2026-10-31T11:00:40Z'),
    '不到 1 分钟',
  );
  assert.equal(took('2026-10-31T11:00:00Z', '2026-10-31T11:07:00Z'), '7 分钟');
  assert.equal(
    took('2026-10-31T11:00:00Z', '2026-10-31T12:11:00Z'),
    '1 小时 11 分钟',
  );
  assert.equal(took('2026-10-31T11:00:00Z', '2026-10-31T13:00:00Z'), '2 小时');
});
