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
    let a = f.create({ owner: null, reviewer: null }).task;
    a = f.act(f.developer, a, { type: 'claim' }).task;
    a = f.act(f.developer, a, { type: 'progress', note: 'Halfway' }).task;
    a = f.act(f.developer, a, {
      type: 'link-execution',
      reference: {
        backend: 't3',
        environmentId: 'env',
        threadId: 'thread',
        runId: 'run',
      },
      note: 'Run reference',
    }).task;
    a = f.act(f.developer, a, {
      type: 'request-review',
      reviewer: rev,
      note: 'Ready',
    }).task;
    a = f.act(f.reviewPrincipal, a, {
      type: 'review',
      decision: 'approve',
      note: 'Looks right',
    }).task;
    a = f.act(f.principal, a, { type: 'accept', note: 'Ship it' }).task;
    // B: handoff (work) → handoff (review) → changes → rework → cancel.
    let b = f.create({ owner: dev, reviewer: null }).task;
    b = f.act(f.principal, b, {
      type: 'handoff',
      mode: 'work',
      recipient: me,
      note: 'I will take this',
    }).task;
    b = f.act(f.principal, b, {
      type: 'handoff',
      mode: 'review',
      recipient: rev,
      note: 'Please check',
    }).task;
    b = f.act(f.reviewPrincipal, b, {
      type: 'review',
      decision: 'rework',
      note: 'Missing tests',
    }).task;
    b = f.act(f.principal, b, { type: 'rework', note: 'Add tests' }).task;
    b = f.act(f.principal, b, { type: 'cancel', note: 'Superseded' }).task;
    const data = WorkspaceSnapshot.parse(
      (
        await f.app.inject({
          url: '/api/workspace?channelId=' + f.channelId,
          cookies: f.cookies,
        })
      ).json<unknown>(),
    );
    const lines = (id: typeof a.id) =>
      f.tasks
        .history(f.principal, f.teamId, f.channelId, id)
        .items.map((e) => historySentence(e, data));
    const sentences = [...lines(a.id), ...lines(b.id)];
    const expected = [
      /^You created the task$/,
      /^Developer took it on$/,
      /^Developer posted progress: “Halfway”$/,
      /^Developer linked a T3 run$/,
      /^Developer asked Reviewer to review: “Ready”$/,
      /^Reviewer approved the review: “Looks right”$/,
      /^You accepted it: “Ship it”$/,
      /^You created the task$/,
      /^You took over the work: “I will take this”$/,
      /^You asked Reviewer to review: “Please check”$/,
      /^Reviewer asked for changes: “Missing tests”$/,
      /^You sent it back: “Add tests”$/,
      /^You cancelled it: “Superseded”$/,
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
