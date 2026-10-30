import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ChannelId, TaskId } from '../domain/contracts.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import {
  ChannelView,
  Message,
  MessageId,
  Topic,
  TopicId,
  TopicInput,
  PageInput,
  PostInput,
  pageOf,
} from '../domain/communication.js';
import {
  Task,
  TaskCreate,
  TaskCommand,
  TaskEvent,
  TaskExecution,
  TaskResult,
} from '../domain/tasks.js';
import { resolvePrincipal } from '../server/principals.js';
import type { Store } from '../persistence/store.js';

export const Failure = z.strictObject({
  code: z.enum([
    'invalid_input',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
    'internal',
  ]),
  message: z.enum([
    'Authentication required',
    'Permission denied',
    'Resource unavailable',
    'Operation conflicts',
    'Invalid input',
    'Operation failed',
  ]),
});
export const outcome = <T extends z.ZodType>(data: T) =>
  z.strictObject({
    result: z.discriminatedUnion('ok', [
      z.strictObject({ ok: z.literal(true), data }),
      z.strictObject({ ok: z.literal(false), error: Failure }),
    ]),
  });
function failure(error: unknown): z.infer<typeof Failure> {
  if (error instanceof IdentityError) {
    switch (error.statusCode) {
      case 400:
        return { code: 'invalid_input', message: 'Invalid input' };
      case 401:
        return { code: 'unauthenticated', message: 'Authentication required' };
      case 403:
        return { code: 'forbidden', message: 'Permission denied' };
      case 404:
        return { code: 'not_found', message: 'Resource unavailable' };
      case 409:
        return { code: 'conflict', message: 'Operation conflicts' };
    }
  }
  return { code: 'internal', message: 'Operation failed' };
}
export function agentPrincipal(
  store: Store,
  authorization: string | undefined,
) {
  const principal = resolvePrincipal(store, authorization, undefined);
  if (principal.kind !== 'agent') throw new IdentityError(401);
  return principal;
}
/** One stateless SDK instance per HTTP request. Credentials never come from tool arguments. */
export function teamServer(store: Store, authorization: string) {
  const server = new McpServer({ name: 'kinmesh-team', version: '0.1.0' });
  const channel = z.strictObject({ channelId: ChannelId });
  const task = channel.extend({ taskId: TaskId });
  const pagedChannel = channel.extend(PageInput.shape);
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    input: z.ZodObject<S>,
    output: z.ZodType,
    readOnly: boolean,
    run: (
      p: Extract<Principal, { kind: 'agent' }>,
      data: z.output<z.ZodObject<S>>,
    ) => unknown,
  ) {
    const schema = outcome(output);
    server.registerTool<typeof schema, typeof input>(
      name,
      {
        description,
        inputSchema: input,
        outputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (args) => {
        // Validate output separately: corrupt stored data is never reported as bad caller input.
        let value: unknown;
        try {
          const p = agentPrincipal(store, authorization);
          value = run(p, input.parse(args));
        } catch (error) {
          const result = schema.parse({
            result: { ok: false, error: failure(error) },
          });
          return {
            isError: true,
            structuredContent: result,
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        }
        const parsed = output.safeParse(value);
        const result = schema.parse(
          parsed.success
            ? { result: { ok: true, data: parsed.data } }
            : { result: { ok: false, error: failure(undefined) } },
        );
        return {
          isError: !parsed.success,
          structuredContent: result,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      },
    );
  }
  const c = store.communication;
  register(
    'team_channels_list',
    'List joined channels. Discovery does not grant access.',
    PageInput,
    pageOf(ChannelView),
    true,
    (p, args) => c.channels(p, p.teamId, args),
  );
  register(
    'team_channel_get',
    'Read a joined channel.',
    channel,
    ChannelView,
    true,
    (p, a) => c.channel(p, p.teamId, a.channelId),
  );
  register(
    'team_topics_list',
    'List channel topics.',
    pagedChannel,
    pageOf(Topic),
    true,
    (p, { channelId, ...page }) => c.topics(p, p.teamId, channelId, page),
  );
  register(
    'team_topic_create',
    'Create a channel topic with a stable operationKey.',
    channel.extend(TopicInput.shape),
    Topic,
    false,
    (p, { channelId, ...data }) => c.createTopic(p, p.teamId, channelId, data),
  );
  register(
    'team_messages_read',
    'Read channel history, optionally restricted to a topic.',
    pagedChannel.extend({ topicId: TopicId.optional() }),
    pageOf(Message),
    true,
    (p, { channelId, topicId, ...page }) =>
      c.history(p, p.teamId, channelId, page, topicId),
  );
  register(
    'team_message_get',
    'Read one authorized message.',
    channel.extend({ messageId: MessageId }),
    Message,
    true,
    (p, a) => c.message(p, p.teamId, a.channelId, a.messageId),
  );
  register(
    'team_messages_send',
    'Post as the verified agent. Reuse operationKey only for the exact same operation.',
    channel.extend(PostInput.shape),
    Message,
    false,
    (p, { channelId, ...data }) => c.post(p, p.teamId, channelId, data),
  );
  register(
    'team_tasks_list',
    'List tasks in a joined channel.',
    pagedChannel,
    pageOf(Task),
    true,
    (p, { channelId, ...page }) =>
      store.tasks.list(p, p.teamId, channelId, page),
  );
  register(
    'team_task_get',
    'Read task responsibility, not provider completion.',
    task,
    Task,
    true,
    (p, a) => store.tasks.get(p, p.teamId, a.channelId, a.taskId),
  );
  register(
    'team_tasks_history',
    'Read immutable task decisions.',
    task.extend(PageInput.shape),
    pageOf(TaskEvent),
    true,
    (p, { channelId, taskId, ...page }) =>
      store.tasks.history(p, p.teamId, channelId, taskId, page),
  );
  register(
    'team_task_executions',
    'Read asserted external references, not verified run status.',
    task.extend(PageInput.shape),
    pageOf(TaskExecution),
    true,
    (p, { channelId, taskId, ...page }) =>
      store.tasks.executions(p, p.teamId, channelId, taskId, page),
  );
  register(
    'team_task_create',
    'Propose a task or assign yourself; human acceptance is separate.',
    channel.extend(TaskCreate.shape),
    TaskResult,
    false,
    (p, { channelId, ...data }) =>
      store.tasks.create(p, p.teamId, channelId, data),
  );
  for (const command of TaskCommand.options) {
    const { type, ...fields } = command.shape;
    const action = type.value;
    // Human-only decisions are deliberately absent from the agent transport.
    if (action === 'accept' || action === 'rework' || action === 'cancel')
      continue;
    register(
      'team_task_' + action.replaceAll('-', '_'),
      'Apply ' +
        action +
        '. Requires assignment/scope, stable operationKey and current expectedVersion. Technical review never accepts a task.',
      z.strictObject({ ...fields, ...task.shape }),
      TaskResult,
      false,
      (p, { channelId, taskId, ...data }) =>
        store.tasks.command(
          p,
          p.teamId,
          channelId,
          taskId,
          TaskCommand.parse({ ...data, type: action }),
        ),
    );
  }
  return server;
}
