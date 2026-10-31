import { readFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LiveContext } from '../src/team-mcp/live-context.js';
import { connectAgent, loadAgentToken } from '../src/team-mcp/client.js';
import { outcome } from '../src/team-mcp/tools.js';
import { Task } from '../src/domain/tasks.js';
import { Message, pageOf } from '../src/domain/communication.js';
import {
  loadCredential,
  Endpoint,
  authority,
} from '../src/adapters/t3/oauth.js';
import { SdkWire } from '../src/adapters/t3/sdk.js';
import { T3Backend } from '../src/adapters/t3/backend.js';
import { ValidatedTools } from '../src/adapters/t3/contracts.js';
import { openStore } from '../src/persistence/store.js';
import type { Reference } from '../src/domain/execution.js';

process.umask(0o077);
const Config = z.object({
  KINMESH_TEAM_T3_LIVE: z.literal('1'),
  KINMESH_TEAM_LIVE_DIR: z.string().min(1),
  KINMESH_T3_ENDPOINT: Endpoint,
  KINMESH_T3_AUTH_FILE: z.string().min(1),
  KINMESH_TEAM_T3_ISOLATED_PROVIDER: z.string().min(1),
  KINMESH_T3_MODEL: z.string().min(1),
});
let client: Awaited<ReturnType<typeof connectAgent>> | undefined;
let wire: SdkWire | undefined;
let store: ReturnType<typeof openStore> | undefined;
let reference: Reference | undefined;
let tools: ValidatedTools | undefined;
let backend: T3Backend | undefined;
let stage = 'configuration';
try {
  const c = Config.parse(process.env);
  const directory = resolve(c.KINMESH_TEAM_LIVE_DIR);
  if (
    dirname(directory) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('kinmesh-team-live-')
  )
    throw new Error('Disposable path required');
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error('Private directory required');
  const context = LiveContext.parse(
    JSON.parse(readFileSync(join(directory, 'context.json'), 'utf8')),
  );
  if (
    context.database !== join(directory, 'team.sqlite') ||
    context.tokenFile !== join(directory, 'developer.json')
  )
    throw new Error('Wrong fixture');
  stage = 'team-read-authentication';
  client = await connectAgent(context.endpoint, context.tokenFile);
  const taskArgs = { channelId: context.channelId, taskId: context.taskId };
  const initial = outcome(Task).parse(
    (await client.callTool({ name: 'team_task_get', arguments: taskArgs }))
      .structuredContent,
  ).result;
  if (
    !initial.ok ||
    initial.data.state.status !== 'proposed' ||
    initial.data.version !== 1
  )
    throw new Error('Fresh task required');
  const source = outcome(Message).parse(
    (
      await client.callTool({
        name: 'team_message_get',
        arguments: {
          channelId: context.channelId,
          messageId: context.sourceMessageId,
        },
      })
    ).structuredContent,
  ).result;
  if (!source.ok) throw new Error('Missing read proof');
  const nonce = 'TEAM_LIVE_' + randomUUID();
  const messageKey = 'send-' + nonce;
  stage = 't3-authentication-capability';
  const credential = loadCredential(
    c.KINMESH_T3_AUTH_FILE,
    c.KINMESH_T3_ENDPOINT,
  );
  wire = new SdkWire(credential);
  store = openStore(context.database);
  backend = await T3Backend.connect(wire, store.operations, {
    endpoint: credential.endpoint,
    expectedEnvironmentId: credential.environmentId,
    authority: authority(credential),
    scopes: credential.tokens.scope?.split(' ') ?? [],
  });
  tools = new ValidatedTools(wire, await wire.list());
  stage = 't3-provider-launch';
  // No Team MCP mutations are made by this gate; only the launched provider may perform them.
  const dispatched = await backend.launch(
    {
      target: { kind: 'scratch' },
      title: 'Disposable Team MCP provider acceptance',
      model: {
        providerId: c.KINMESH_TEAM_T3_ISOLATED_PROVIDER,
        modelId: c.KINMESH_T3_MODEL,
      },
      mode: 'approval-required',
      message: `Use ONLY the external Kinmesh Team MCP tools. Do not edit files, run shell commands, call T3 tools, accept tasks or request approvals. Read message ${context.sourceMessageId} in channel ${context.channelId} with team_message_get. Post a new message with team_messages_send: body must be "${nonce}:" followed by the exact read message body; operationKey "${messageKey}", topicId null, mentions [], sourceMessageId "${context.sourceMessageId}", sourceEventId null. Claim task ${context.taskId} in that channel using team_task_claim, expectedVersion 1, operationKey "claim-${nonce}". Then call team_task_handoff on it with expectedVersion 2, operationKey "handoff-${nonce}", mode "review", recipient {"kind":"agent","id":"${context.reviewerId}"}, note "${nonce}". Stop after handoff and reply briefly. A provider turn is not human task acceptance.`,
    },
    { actor: 'local-team-live-owner', operationKey: nonce },
  );
  if (dispatched.kind !== 'known' || !dispatched.reference.runId)
    throw new Error('Uncertain launch');
  reference = dispatched.reference;
  stage = 't3-provider-completion';
  let completed = false;
  for (let i = 0; i < 12; i++) {
    const result = await backend.wait(reference, 20000);
    if (result.kind === 'observed' && result.observation.terminal) {
      completed = result.observation.state === 'succeeded';
      break;
    }
  }
  const observed = await backend.read(reference);
  if (
    !completed ||
    !observed.terminal ||
    observed.pendingRequests !== 0 ||
    observed.model.providerId !== c.KINMESH_TEAM_T3_ISOLATED_PROVIDER
  )
    throw new Error('Provider did not complete');
  stage = 'authoritative-team-effects';
  const final = outcome(Task).parse(
    (await client.callTool({ name: 'team_task_get', arguments: taskArgs }))
      .structuredContent,
  ).result;
  if (
    !final.ok ||
    final.data.state.status !== 'review-requested' ||
    final.data.version !== 3 ||
    final.data.state.owner.kind !== 'agent' ||
    final.data.state.owner.id !== context.agentId ||
    final.data.state.reviewer.kind !== 'agent' ||
    final.data.state.reviewer.id !== context.reviewerId
  )
    throw new Error('Missing responsibility effects');
  let cursor: string | undefined;
  let found = false;
  for (let i = 0; i < 20; i++) {
    const response = outcome(pageOf(Message)).parse(
      (
        await client.callTool({
          name: 'team_messages_read',
          arguments: {
            channelId: context.channelId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
        })
      ).structuredContent,
    ).result;
    if (!response.ok) throw new Error('Read failed');
    found ||= response.data.items.some(
      (m) =>
        m.body === nonce + ':' + source.data.body &&
        m.author.kind === 'agent' &&
        m.author.agentId === context.agentId &&
        m.sourceMessageId === context.sourceMessageId,
    );
    if (response.data.nextCursor === null) break;
    cursor = response.data.nextCursor;
  }
  if (!found) throw new Error('Missing read/post evidence');
  // The durable receipt proves exact operation-key execution, not just matching display text.
  const principal = store.agents.resolveToken(
    loadAgentToken(context.tokenFile),
  );
  const task = store.tasks.get(
    principal,
    context.teamId,
    context.channelId,
    context.taskId,
  );
  const history = store.tasks.history(
    principal,
    context.teamId,
    context.channelId,
    task.id,
  ).items;
  if (
    history.length !== 3 ||
    history[1]?.command.operationKey !== 'claim-' + nonce ||
    history[2]?.command.operationKey !== 'handoff-' + nonce
  )
    throw new Error('Missing persisted audit');
  console.info(
    'TEAM_T3_PROVIDER_LIVE PASS: real T3 run completed; Team MCP read proof, attributed post, atomic claim and reviewer handoff persisted; no human acceptance.',
  );
} catch {
  console.error(
    'TEAM_T3_PROVIDER_LIVE FAIL at ' +
      stage +
      ': requires private disposable context, running Team MCP, approved T3 OAuth and an isolated provider configured for that endpoint/grant.',
  );
  process.exitCode = 1;
} finally {
  if (reference && tools) {
    try {
      if (!backend) throw new Error('Missing backend');
      let state = await backend.read(reference);
      if (!state.terminal) {
        await backend.stop(reference, {
          actor: 'local-team-live-owner',
          operationKey: randomUUID(),
        });
        await backend.wait(reference, 20000);
        state = await backend.read(reference);
      }
      if (!state.terminal) throw new Error('Disposable run still active');
      await tools.call('t3_thread_organize', {
        threadId: reference.threadId,
        action: 'archive',
      });
    } catch {
      console.error(
        'TEAM_T3_PROVIDER_CLEANUP FAIL: owner must inspect the disposable thread privately.',
      );
      process.exitCode = 1;
    }
  }
  await client?.close();
  await wire?.close();
  store?.close();
}
