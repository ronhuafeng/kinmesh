import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewProof, type Activity } from './live/proof.js';

const context = {
  channelId: 'channel',
  taskId: 'task',
  developerId: 'developer',
  developerEventId: 'developer-event',
  humanId: 'human',
  marker: 'marker',
  rework: true,
  reworkNote: 'keep marker; add verified',
};
const artifact = {
  body: 'marker v2: 7 x 8 = 56; verified',
  sourceEventId: 'developer-event',
  author: { kind: 'agent', agentId: 'developer' },
};
const rework = {
  taskId: 'task',
  action: 'rework',
  author: { kind: 'human', humanId: 'human' },
  command: { note: context.reworkNote },
};
function call(
  name: string,
  data: unknown,
  completed = true,
): Activity['items'][number] {
  return {
    itemId: name,
    runId: 'run',
    type: 'dynamic_tool',
    status: completed ? 'completed' : 'running',
    textTruncated: false,
    text: JSON.stringify({
      toolName: 'kinmesh.' + name,
      input: { taskId: 'task', channelId: 'channel' },
      ...(completed ? { output: { result: { ok: true, data } } } : {}),
    }),
  };
}
function valid() {
  return {
    items: [
      call('team_task_get', {}),
      call('team_tasks_history', { items: [rework] }),
      call('team_messages_read', { items: [artifact] }),
    ],
  };
}
await test('LIVE ORACLE FIXTURE: actual completed correct-task reads establish pre-approval proof', () => {
  assert.equal(reviewProof(valid(), 'run', context).length, 3);
});
await test('LIVE ORACLE FIXTURE: read items created first but still running do not prove causal completion', () => {
  const activity = valid();
  activity.items[1] = call('team_tasks_history', { items: [rework] }, false);
  assert.throws(
    () => reviewProof(activity, 'run', context),
    /REVIEW_TASK_READ_MISSING/,
  );
});
await test('LIVE ORACLE FIXTURE: later-completed reads cannot establish a witness after review already executed', () => {
  const activity = valid();
  activity.items.push(call('team_task_review', {}));
  assert.throws(
    () => reviewProof(activity, 'run', context),
    /REVIEW_ALREADY_EXECUTED/,
  );
});
await test('LIVE ORACLE FIXTURE: a history call with no actual Human rework cannot pass the second cycle', () => {
  const activity = valid();
  activity.items[1] = call('team_tasks_history', { items: [] });
  assert.throws(
    () => reviewProof(activity, 'run', context),
    /REVIEW_HUMAN_REWORK_READ_MISSING/,
  );
});
await test('LIVE ORACLE FIXTURE: another task, Human or source event is not evidence for this review', () => {
  for (const changed of [
    { ...context, taskId: 'other' },
    { ...context, humanId: 'other' },
    { ...context, developerEventId: 'other' },
  ])
    assert.throws(() => reviewProof(valid(), 'run', changed));
});
await test('LIVE ORACLE FIXTURE: earlier artifact and another Run cannot satisfy current rework', () => {
  const activity = valid();
  activity.items[2] = call('team_messages_read', {
    items: [{ ...artifact, body: 'marker v1: 7 x 8 = 56' }],
  });
  assert.throws(
    () => reviewProof(activity, 'run', context),
    /REVIEW_ACTUAL_ARTIFACT_READ_MISSING/,
  );
  assert.throws(
    () => reviewProof(valid(), 'other-run', context),
    /REVIEW_TASK_READ_MISSING/,
  );
});

await test('LIVE ORACLE FIXTURE: real Grok wrapper yields the same verified Team response', async () => {
  const { parseCall } = await import('./live/proof.js');
  const raw = {
    toolName: 'kinmesh__team_task_get',
    input: {
      tool_name: 'kinmesh__team_task_get',
      tool_input: { channelId: 'channel', taskId: 'task' },
      variant: 'grok',
    },
    output: {
      type: 'mcp_tool_result',
      tool_name: 'team_task_get',
      server_name: 'kinmesh',
      output: {
        OkayOutput: JSON.stringify({
          result: { ok: true, data: { id: 'task' } },
        }),
      },
    },
  };
  const parsed = parseCall(raw);
  assert.deepEqual(parsed, {
    name: 'team_task_get',
    input: { channelId: 'channel', taskId: 'task' },
    output: { result: { ok: true, data: { id: 'task' } } },
  });
  assert.throws(() =>
    parseCall({
      ...raw,
      input: { ...raw.input, tool_name: 'other__team_task_get' },
    }),
  );
  assert.throws(() =>
    parseCall({ ...raw, output: { ...raw.output, server_name: 'other' } }),
  );
});

await test('LIVE ORACLE FIXTURE: native approvals match per tool and tolerate an approved same-tool call still running', async () => {
  const { approvalCandidates } = await import('./live/proof.js');
  const request = (name: string, id: string): Activity['items'][number] => ({
    itemId: id,
    runId: 'run',
    type: 'approval_request',
    status: 'waiting',
    textTruncated: false,
    text: `Allow the kinmesh MCP server to run tool "${name}"?`,
  });
  const pending = (name: string, id: string) => ({
    ...call(name, undefined, false),
    itemId: id,
  });
  const a = 'team_messages_send',
    b = 'team_task_handoff';
  assert.throws(
    () =>
      approvalCandidates(
        {
          items: [
            pending(a, 'a1'),
            pending(a, 'a2'),
            request(a, 'ra'),
            request(b, 'rb'),
          ],
        },
        'run',
        2,
      ),
    /NATIVE_APPROVAL_INPUT_MISSING/,
  );
  assert.equal(
    approvalCandidates(
      { items: [pending(a, 'a1'), pending(a, 'a2'), request(a, 'ra')] },
      'run',
      1,
    ).calls.length,
    2,
  );
  assert.equal(
    approvalCandidates(
      {
        items: [
          pending(a, 'a1'),
          pending(b, 'b1'),
          request(a, 'ra'),
          request(b, 'rb'),
        ],
      },
      'run',
      2,
    ).requests.length,
    2,
  );
  assert.throws(
    () =>
      approvalCandidates({ items: [call(a, {}), request(a, 'ra')] }, 'run', 1),
    /NATIVE_APPROVAL_INPUT_MISSING/,
  );
});

await test('LIVE ORACLE FIXTURE: the correlation owner and task link must identify the exact original execution', async () => {
  const { identityLinks } = await import('./live/proof.js');
  const reference = {
    backend: 't3',
    environmentId: 'environment',
    threadId: 'thread',
    runId: 'run',
  };
  const expected = {
    teamId: 'team',
    agentId: 'agent',
    taskId: 'task',
    reference,
  };
  const association = {
    team_id: 'team',
    agent_id: 'agent',
    reference: JSON.stringify(reference),
  };
  const link = { task_id: 'task', reference: JSON.stringify(reference) };
  identityLinks(association, link, expected);
  assert.throws(() => {
    identityLinks({ ...association, agent_id: 'other' }, link, expected);
  });
  assert.throws(() => {
    identityLinks({ ...association, team_id: 'other' }, link, expected);
  });
  assert.throws(() => {
    identityLinks(
      association,
      { ...link, reference: JSON.stringify({ ...reference, runId: 'other' }) },
      expected,
    );
  });
});
