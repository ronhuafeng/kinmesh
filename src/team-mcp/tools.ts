import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  OpeningRefusal,
  PULL_REQUEST_CHANGE_BYTES,
  TaskPullRequestView,
} from '../domain/pull-requests.js';
import { hubRequest } from './hub.js';
import { z } from 'zod';
import { ChannelId, TaskId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
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
  OpenPullRequest,
  TaskEvent,
  TaskExecution,
  TaskResult,
} from '../domain/tasks.js';
import { resolvePrincipal } from '../persistence/principals.js';
import type { Store } from '../persistence/store.js';
import type { AttachmentStore } from '../persistence/attachment-store.js';
import { Attachment, AttachmentId } from '../domain/attachments.js';

/** The most `team_attachment_read` returns of a file. */
const ATTACHMENT_READ_MOST = 1024 * 1024;
const AttachmentContent = z.strictObject({
  attachment: Attachment,
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
});
/** The bytes as text, when they are UTF-8 without NUL; else null. */
function asText(bytes: Buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}
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
  /** What to change, when the code alone would not say. */
  reason: OpeningRefusal.optional(),
});
export const outcome = <T extends z.ZodType>(data: T) =>
  z.strictObject({
    result: z.discriminatedUnion('ok', [
      z.strictObject({ ok: z.literal(true), data }),
      z.strictObject({ ok: z.literal(false), error: Failure }),
    ]),
  });
function failure(error: unknown): z.infer<typeof Failure> {
  if (error instanceof DomainError) {
    const reason = OpeningRefusal.safeParse(error.reason);
    return {
      ...refusal(error),
      ...(reason.success ? { reason: reason.data } : {}),
    };
  }
  return { code: 'internal', message: 'Operation failed' };
}
function refusal(error: DomainError): z.infer<typeof Failure> {
  switch (error.kind) {
    case 'invalid':
    case 'too-large':
      return { code: 'invalid_input', message: 'Invalid input' };
    case 'unauthenticated':
      return { code: 'unauthenticated', message: 'Authentication required' };
    case 'forbidden':
      return { code: 'forbidden', message: 'Permission denied' };
    case 'not-found':
      return { code: 'not_found', message: 'Resource unavailable' };
    case 'conflict':
      return { code: 'conflict', message: 'Operation conflicts' };
  }
}
export async function agentPrincipal(
  store: Store,
  authorization: string | undefined,
) {
  const principal = await resolvePrincipal(store, authorization, undefined);
  if (principal.kind !== 'agent') throw new DomainError('unauthenticated');
  return principal;
}
/** One stateless SDK instance per HTTP request. Credentials never come from tool arguments. */
export function teamServer(
  store: Store,
  authorization: string,
  files: AttachmentStore,
  hub: string,
) {
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
    ) => Promise<unknown>,
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
      async (args) => {
        // Validate output separately: corrupt stored data is never reported as bad caller input.
        let value: unknown;
        try {
          const p = await agentPrincipal(store, authorization);
          value = await run(p, input.parse(args));
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
  register(
    'team_channels_list',
    'List joined channels. Discovery does not grant access.',
    PageInput,
    pageOf(ChannelView),
    true,
    (p, args) => store.channels.channels(p, p.teamId, args),
  );
  register(
    'team_channel_get',
    'Read a joined channel.',
    channel,
    ChannelView,
    true,
    (p, a) => store.channels.channel(p, p.teamId, a.channelId),
  );
  register(
    'team_topics_list',
    'List channel topics.',
    pagedChannel,
    pageOf(Topic),
    true,
    (p, { channelId, ...page }) =>
      store.topics.topics(p, p.teamId, channelId, page),
  );
  register(
    'team_topic_create',
    'Create a channel topic with a stable operationKey.',
    channel.extend(TopicInput.shape),
    Topic,
    false,
    (p, { channelId, ...data }) =>
      store.topics.createTopic(p, p.teamId, channelId, data),
  );
  register(
    'team_messages_read',
    'Read channel history, optionally restricted to a topic: the newest messages first, each page oldest to newest; nextCursor reads older ones.',
    pagedChannel.extend({ topicId: TopicId.optional() }),
    pageOf(Message),
    true,
    (p, { channelId, topicId, ...page }) =>
      store.messages.history(p, p.teamId, channelId, page, topicId),
  );
  register(
    'team_message_get',
    'Read one authorized message.',
    channel.extend({ messageId: MessageId }),
    Message,
    true,
    (p, a) => store.messages.message(p, p.teamId, a.channelId, a.messageId),
  );
  register(
    'team_attachment_read',
    `Read a file attached to a message in a joined channel, up to ${String(ATTACHMENT_READ_MOST / 1024 / 1024)} MB: text as UTF-8, anything else as base64.`,
    channel.extend({ attachmentId: AttachmentId }),
    AttachmentContent,
    true,
    async (p, a) => {
      const { attachment, sha256 } = await store.files.attachment(
        p,
        p.teamId,
        a.channelId,
        a.attachmentId,
      );
      if (attachment.size > ATTACHMENT_READ_MOST)
        throw new DomainError('too-large');
      const content = Buffer.concat(await (await files.read(sha256)).toArray());
      const text = asText(content);
      return {
        attachment,
        encoding: text === null ? 'base64' : 'utf8',
        content: text ?? content.toString('base64'),
      };
    },
  );
  register(
    'team_messages_send',
    'Post as the verified agent. Reuse operationKey only for the exact same operation.',
    channel.extend(PostInput.shape),
    Message,
    false,
    (p, { channelId, ...data }) =>
      store.messages.post(p, p.teamId, channelId, data),
  );
  register(
    'team_tasks_list',
    'List tasks in a joined channel: the newest first, each page oldest to newest; nextCursor reads older ones.',
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
    'team_task_pull_requests',
    "Read the pull requests linked to a task, each with what GitHub last said and when. A link is its linker's claim; GitHub's state never accepts a task.",
    task,
    z.array(TaskPullRequestView),
    true,
    (p, a) => store.tasks.pullRequests(p, p.teamId, a.channelId, a.taskId),
  );
  register(
    'team_task_create',
    'Propose a task or assign yourself; human acceptance is separate.',
    // Who accepts is never an agent's to say.
    channel.extend(TaskCreate.omit({ acceptor: true }).shape),
    TaskResult,
    false,
    (p, { channelId, ...data }) =>
      store.tasks.create(p, p.teamId, channelId, data),
  );
  for (const command of TaskCommand.options) {
    const { type, ...fields } = command.shape;
    const action = type.value;
    // Human-only decisions, and the acceptor's say over what is asked, are
    // deliberately absent from the agent transport.
    // An opened pull request is the hub's to record, below.
    if (
      action === 'accept' ||
      action === 'rework' ||
      action === 'cancel' ||
      action === 'edit' ||
      action === 'open-pull-request'
    )
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
  register(
    'team_task_open_pull_request',
    `Open your change as a pull request linked to a task you are working on. Kinmesh makes a new branch from base (the repository's default branch when null) with one commit of each file's whole new text (null removes the file), at most ${String(PULL_REQUEST_CHANGE_BYTES / 1024 / 1024)} MiB, and opens the pull request in Kinmesh's name on your behalf. Requires stable operationKey and current expectedVersion; a retry never opens a second one. A refusal's reason says what to change: github-not-connected (ask a person to connect GitHub), repository-not-connected, base-missing, branch-taken (choose another branch).`,
    z.strictObject({ ...task.shape, ...OpenPullRequest.shape }),
    TaskResult,
    false,
    (p, { channelId, taskId, ...data }) =>
      hubRequest(
        hub,
        authorization,
        `/api/teams/${p.teamId}/channels/${channelId}/tasks/${taskId}/open-pull-request`,
        data,
      ),
  );
  return server;
}
