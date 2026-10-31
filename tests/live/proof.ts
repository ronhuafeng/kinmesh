import assert from 'node:assert/strict';
import { z } from 'zod';
import { Read } from '../../src/adapters/t3/contracts.js';

// Public T3 0.1.5 MCP item lifecycle fields; no private runtime projection.
export const Activity = Read.extend({
  items: z.array(Read.shape.items.element.extend({ status: z.string() })),
});
export type Activity = z.infer<typeof Activity>;
const Result = z.object({
  result: z.object({ ok: z.boolean(), data: z.unknown().optional() }),
});
export function parseCall(value: unknown) {
  const raw = z
    .object({
      toolName: z.string(),
      input: z.record(z.string(), z.unknown()),
      output: z.unknown().optional(),
    })
    .parse(value);
  const prefix = /^(?:kinmesh\.|kinmesh__)/;
  if (!prefix.test(raw.toolName)) return undefined;
  let input = raw.input;
  if (raw.toolName.startsWith('kinmesh__')) {
    assert.equal(raw.input.tool_name, raw.toolName);
    const nested = raw.input.tool_input;
    input = z
      .record(z.string(), z.unknown())
      .parse(
        typeof nested === 'string' ? (JSON.parse(nested) as unknown) : nested,
      );
  }
  let output: z.infer<typeof Result> | undefined;
  if (raw.output !== undefined) {
    let source: unknown = raw.output;
    if (raw.toolName.startsWith('kinmesh__')) {
      const wrapped = z
        .object({
          tool_name: z.string(),
          server_name: z.literal('kinmesh'),
          output: z.object({ OkayOutput: z.string() }),
        })
        .parse(raw.output);
      assert.equal(
        wrapped.tool_name.replace(/^kinmesh__/, ''),
        raw.toolName.replace(/^kinmesh__/, ''),
      );
      source = JSON.parse(wrapped.output.OkayOutput) as unknown;
    }
    const candidate: unknown =
      typeof source === 'string' ? (JSON.parse(source) as unknown) : source;
    const direct = Result.safeParse(candidate);
    if (direct.success) output = direct.data;
    else {
      const envelope = z
        .object({
          structuredContent: z.unknown().optional(),
          content: z
            .array(z.object({ type: z.string(), text: z.string().optional() }))
            .optional(),
        })
        .parse(candidate);
      output = Result.parse(
        envelope.structuredContent ??
          (JSON.parse(
            envelope.content
              ?.filter((block) => block.type === 'text')
              .map((block) => block.text ?? '')
              .join('\n') ?? 'null',
          ) as unknown),
      );
    }
  }
  return { name: raw.toolName.replace(prefix, ''), input, output };
}
export function completedCalls(
  activity: Pick<Activity, 'items'>,
  runId: string,
) {
  return activity.items
    .filter(
      (item) =>
        item.type === 'dynamic_tool' &&
        item.runId === runId &&
        item.status === 'completed',
    )
    .flatMap((item) => {
      // Discovery tools are not Team MCP evidence.
      if (!item.text || !/"toolName"\s*:\s*"kinmesh(?:\.|__)/.test(item.text))
        return [];
      assert.equal(item.textTruncated, false);
      const call = parseCall(JSON.parse(item.text) as unknown);
      return call?.output?.result.ok
        ? [
            {
              name: call.name,
              input: call.input,
              data: call.output.result.data,
            },
          ]
        : [];
    });
}
export interface ReviewContext {
  channelId: string;
  taskId: string;
  developerId: string;
  developerEventId: string;
  humanId: string;
  marker: string;
  rework: boolean;
  reworkNote: string;
}
/** Capture successful replies BEFORE permitting the pending native review mutation. */
export function reviewProof(
  activity: Pick<Activity, 'items'>,
  runId: string,
  context: ReviewContext,
) {
  const calls = completedCalls(activity, runId);
  assert.ok(
    !calls.some((call) => call.name === 'team_task_review'),
    'REVIEW_ALREADY_EXECUTED_WITHOUT_WITNESS',
  );
  for (const name of ['team_task_get', 'team_tasks_history'])
    assert.ok(
      calls.some(
        (call) =>
          call.name === name &&
          call.input.channelId === context.channelId &&
          call.input.taskId === context.taskId,
      ),
      'REVIEW_TASK_READ_MISSING',
    );
  const artifacts = calls
    .filter(
      (call) =>
        call.name === 'team_messages_read' &&
        call.input.channelId === context.channelId,
    )
    .flatMap(
      (call) =>
        z
          .object({
            items: z.array(
              z.object({
                body: z.string(),
                sourceEventId: z.string().nullable(),
                author: z.object({
                  kind: z.string(),
                  agentId: z.string().optional(),
                }),
              }),
            ),
          })
          .parse(call.data).items,
    );
  assert.ok(
    artifacts.some(
      (message) =>
        message.author.kind === 'agent' &&
        message.author.agentId === context.developerId &&
        message.sourceEventId === context.developerEventId &&
        message.body.includes(context.marker) &&
        message.body.includes('7 x 8 = 56') &&
        (!context.rework || message.body.includes('verified')),
    ),
    'REVIEW_ACTUAL_ARTIFACT_READ_MISSING',
  );
  if (context.rework) {
    const history = calls
      .filter(
        (call) =>
          call.name === 'team_tasks_history' &&
          call.input.channelId === context.channelId &&
          call.input.taskId === context.taskId,
      )
      .flatMap(
        (call) =>
          z
            .object({
              items: z.array(
                z.object({
                  taskId: z.string(),
                  action: z.string(),
                  author: z.object({
                    kind: z.string(),
                    humanId: z.string().optional(),
                  }),
                  command: z.object({ note: z.string().nullable().optional() }),
                }),
              ),
            })
            .parse(call.data).items,
      );
    assert.ok(
      history.some(
        (event) =>
          event.taskId === context.taskId &&
          event.action === 'rework' &&
          event.author.kind === 'human' &&
          event.author.humanId === context.humanId &&
          event.command.note === context.reworkNote,
      ),
      'REVIEW_HUMAN_REWORK_READ_MISSING',
    );
  }
  return calls;
}

const teamTools = [
  'team_message_get',
  'team_messages_read',
  'team_task_get',
  'team_tasks_history',
  'team_messages_send',
  'team_task_handoff',
  'team_task_review',
];
const unresolved = (status: string) =>
  ['pending', 'waiting', 'running'].includes(status);
/** These are the captured approval prompts for the exact pinned native CLI versions. */
export function approvalTool(text: string | null) {
  const prompt = text?.split('\n')[0] ?? '';
  const match =
    /^(?:kinmesh__(team_[a-z_]+)|Allow the kinmesh MCP server to run tool "(team_[a-z_]+)"\?)$/.exec(
      prompt,
    );
  const name = match?.[1] ?? match?.[2];
  assert.ok(name && teamTools.includes(name), 'UNRECOGNIZED_NATIVE_APPROVAL');
  return name;
}
export function approvalCandidates(
  activity: Pick<Activity, 'items'>,
  runId: string,
  count: number,
) {
  const requests = activity.items
    .filter(
      (item) =>
        item.runId === runId &&
        item.type === 'approval_request' &&
        unresolved(item.status),
    )
    .map((item) => ({ ...item, tool: approvalTool(item.text) }));
  assert.equal(requests.length, count);
  const names = new Set(requests.map((request) => request.tool));
  const calls = activity.items
    .filter(
      (item) =>
        item.runId === runId &&
        item.type === 'dynamic_tool' &&
        unresolved(item.status),
    )
    .flatMap((item) => {
      assert.equal(item.textTruncated, false);
      const call = parseCall(JSON.parse(item.text ?? 'null') as unknown);
      if (!call || !names.has(call.name)) return [];
      assert.equal(call.output, undefined);
      return [{ ...call, itemId: item.itemId }];
    });
  // A same-name call already approved can still be running. Check ALL possible payloads,
  // and require enough distinct candidates for EACH requested tool, never just a total count.
  assert.equal(new Set(calls.map((call) => call.itemId)).size, calls.length);
  for (const name of names)
    assert.ok(
      calls.filter((call) => call.name === name).length >=
        requests.filter((request) => request.tool === name).length,
      'NATIVE_APPROVAL_INPUT_MISSING',
    );
  return { requests, calls };
}

export function identityLinks(
  association: unknown,
  link: unknown,
  expected: {
    teamId: string;
    agentId: string;
    taskId: string;
    reference: unknown;
  },
) {
  const correlation = z
    .object({
      team_id: z.string(),
      agent_id: z.string(),
      reference: z.string(),
    })
    .parse(association);
  const taskLink = z
    .object({ task_id: z.string(), reference: z.string() })
    .parse(link);
  assert.equal(correlation.team_id, expected.teamId);
  assert.equal(correlation.agent_id, expected.agentId);
  assert.equal(taskLink.task_id, expected.taskId);
  assert.deepEqual(
    JSON.parse(correlation.reference) as unknown,
    expected.reference,
  );
  assert.deepEqual(
    JSON.parse(taskLink.reference) as unknown,
    expected.reference,
  );
}
