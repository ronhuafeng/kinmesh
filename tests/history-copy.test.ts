import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historySentence } from '../web/tasks.js';
import { WorkspaceSnapshot } from '../src/workspace/contracts.js';
import { taskFixture } from './task-helpers.js';

await test('every task action reads as a plain sentence in history', async () => {
  const f = await taskFixture();
  try {
    const me = { kind: 'human', id: f.owner.id } as const;
    const dev = { kind: 'agent', id: f.agent.id } as const;
    const rev = { kind: 'agent', id: f.reviewer.id } as const;
    // A: claim → progress → link → review → approve → accept.
    let a = (await f.create({ owner: null, reviewer: null })).task;
    a = (await f.act(f.developer, a, { type: 'claim' })).task;
    a = (await f.act(f.developer, a, { type: 'progress', note: 'Halfway' }))
      .task;
    a = (
      await f.act(f.developer, a, {
        type: 'link-execution',
        reference: {
          backend: 't3',
          environmentId: 'env',
          threadId: 'thread',
          runId: 'run',
        },
        note: 'Run reference',
      })
    ).task;
    a = (
      await f.act(f.developer, a, {
        type: 'request-review',
        reviewer: rev,
        note: 'Ready',
      })
    ).task;
    a = (
      await f.act(f.reviewPrincipal, a, {
        type: 'review',
        decision: 'approve',
        note: 'Looks right',
      })
    ).task;
    a = (await f.act(f.principal, a, { type: 'accept', note: 'Ship it' })).task;
    // B: handoff (work) → handoff (review) → changes → rework → cancel.
    let b = (await f.create({ owner: dev, reviewer: null })).task;
    b = (
      await f.act(f.principal, b, {
        type: 'handoff',
        mode: 'work',
        recipient: me,
        note: 'I will take this',
      })
    ).task;
    b = (
      await f.act(f.principal, b, {
        type: 'handoff',
        mode: 'review',
        recipient: rev,
        note: 'Please check',
      })
    ).task;
    b = (
      await f.act(f.reviewPrincipal, b, {
        type: 'review',
        decision: 'rework',
        note: 'Missing tests',
      })
    ).task;
    b = (await f.act(f.principal, b, { type: 'rework', note: 'Add tests' }))
      .task;
    b = (await f.act(f.principal, b, { type: 'cancel', note: 'Superseded' }))
      .task;
    const data = WorkspaceSnapshot.parse(
      (
        await f.app.inject({
          url: '/api/workspace?channelId=' + f.channelId,
          cookies: f.cookies,
        })
      ).json<unknown>(),
    );
    const lines = async (id: typeof a.id) =>
      (await f.tasks.history(f.principal, f.teamId, f.channelId, id)).items.map(
        (e) => historySentence(e, data),
      );
    const sentences = [...(await lines(a.id)), ...(await lines(b.id))];
    const expected = [
      /^你创建了任务$/,
      /^Developer 认领了任务$/,
      /^Developer 发布了进展：“Halfway”$/,
      /^Developer 关联了一次 T3 运行$/,
      /^Developer 请 Reviewer 审核：“Ready”$/,
      /^Reviewer 审核通过：“Looks right”$/,
      /^你验收通过：“Ship it”$/,
      /^你创建了任务$/,
      /^你接手了工作：“I will take this”$/,
      /^你请 Reviewer 审核：“Please check”$/,
      /^Reviewer 要求修改：“Missing tests”$/,
      /^你退回了任务：“Add tests”$/,
      /^你取消了任务：“Superseded”$/,
    ];
    assert.equal(sentences.length, expected.length, sentences.join('\n'));
    sentences.forEach((line, i) => {
      assert.match(line, expected[i] ?? /^$/);
      assert.doesNotMatch(line, /request-review|link-execution|version|v\d/);
    });
  } finally {
    await f.dispose();
  }
});
