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
