import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { loadWorkerConfig } from '../src/inbox/config.js';
import { LiveContext } from '../src/team-mcp/live-context.js';
import { connectAgent, loadAgentToken } from '../src/team-mcp/client.js';
import { outcome } from '../src/team-mcp/tools.js';
import { Message } from '../src/domain/communication.js';
import { FrozenLaunch, Result } from '../src/domain/inbox.js';
import { Reference } from '../src/domain/execution.js';
import { openStore } from '../src/persistence/store.js';
import { t3Factory } from '../src/inbox/t3.js';
import { assistantResult } from '../src/inbox/worker.js';
import { ValidatedTools } from '../src/adapters/t3/contracts.js';
import { SdkWire } from '../src/adapters/t3/sdk.js';
import { loadCredential } from '../src/adapters/t3/oauth.js';

process.umask(0o077);
let stage = 'configuration';
let store: ReturnType<typeof openStore> | undefined;
let worker: ChildProcess | undefined;
let client: Awaited<ReturnType<typeof connectAgent>> | undefined;
let handle: Awaited<ReturnType<ReturnType<typeof t3Factory>>> | undefined;
let reference: Reference | undefined;
let wire: SdkWire | undefined;
let directory: string | undefined;
let deliveryId: string | undefined;
try {
  const env = z
    .object({
      KINMESH_INBOX_LIVE: z.literal('1'),
      KINMESH_TEAM_LIVE_DIR: z.string().min(1),
      KINMESH_INBOX_CONFIG: z.string().min(1),
    })
    .parse(process.env);
  directory = resolve(env.KINMESH_TEAM_LIVE_DIR);
  if (
    dirname(directory) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('kinmesh-team-live-')
  )
    throw new Error('Disposable directory required');
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
  const config = loadWorkerConfig(env.KINMESH_INBOX_CONFIG);
  const binding = config.bindings[0];
  if (
    config.database !== join(directory, 'team.sqlite') ||
    context.database !== config.database ||
    config.bindings.length !== 1 ||
    binding?.agentId !== context.agentId
  )
    throw new Error('Wrong fixture');
  store = openStore(config.database);
  if (store.inbox.status().some((r) => r.count > 0))
    throw new Error('Fresh inbox required');
  const principal = store.agents.resolveToken(
    loadAgentToken(binding.tokenFile),
  );
  const profile = store.agents.authorize(
    principal,
    context.teamId,
    context.agentId,
    'executions:write',
  );
  store.agents.teamAccess(principal, context.teamId, 'channels:write');
  const initial = store.tasks.get(
    principal,
    context.teamId,
    context.channelId,
    context.taskId,
  );
  if (initial.state.status !== 'proposed' || initial.version !== 1)
    throw new Error('Fresh task required');
  stage = 'native-oauth-contract';
  handle = await t3Factory(store)(binding, profile, AbortSignal.timeout(30000));
  client = await connectAgent(context.endpoint, binding.tokenFile);
  // The ordinary process consumes the event. This gate never calls deliver() or launches the provider directly.
  stage = 'ordinary-worker-start';
  worker = spawn(process.execPath, ['--import', 'tsx', 'src/inbox/main.ts'], {
    env: {
      ...process.env,
      KINMESH_INBOX_CONFIG: resolve(env.KINMESH_INBOX_CONFIG),
    },
    stdio: 'ignore',
  });
  const nonce = 'INBOX_NATIVE_' + randomUUID();
  stage = 'mention-wake-and-result';
  const source = store.communication.post(
    { kind: 'human', humanId: context.humanId },
    context.teamId,
    context.channelId,
    {
      operationKey: nonce,
      body:
        'Read this source message through external Team MCP and reply in your assistant response with exactly this proof: ' +
        nonce +
        '. Do not edit files, run commands, change tasks or send another channel message. No task acceptance is authorized.',
      topicId: null,
      mentions: [{ kind: 'agent', id: context.agentId }],
      sourceMessageId: null,
      sourceEventId: null,
    },
  );
  const deadline = Date.now() + 300000;
  // Source event ID is resolved through an authorized bounded page in this fresh disposable channel.
  const event = store.communication
    .events(principal, context.teamId, context.channelId, { limit: 100 })
    .items.find((e) => e.fact.messageId === source.id);
  if (!event) throw new Error('Missing source event');
  // The trusted worker claim is observed locally; identity is still independently checked via Team MCP below.
  deliveryId = store.inbox.find(event.fact.id, context.agentId)?.id;
  if (!deliveryId) throw new Error('Missing durable delivery');
  while (Date.now() < deadline) {
    const delivery = store.inbox.get(deliveryId);
    if (delivery.state === 'acked') break;
    if (
      delivery.state === 'blocked' ||
      worker.exitCode !== null ||
      worker.signalCode !== null
    )
      throw new Error('Worker blocked or exited');
    await delay(1000);
  }
  if (!deliveryId) throw new Error('Native result not published');
  const row = store.inbox.get(deliveryId);
  if (
    row.state !== 'acked' ||
    row.eventId !== event.fact.id ||
    row.messageId !== source.id ||
    !row.resultMessageId
  )
    throw new Error('Missing ACK');
  reference = Reference.parse(JSON.parse(row.reference ?? ''));
  const frozen = FrozenLaunch.parse(JSON.parse(row.launch ?? ''));
  const actual = await assistantResult(
    handle.backend,
    reference,
    frozen.input.model,
    AbortSignal.timeout(30000),
  );
  if (
    actual.kind !== 'result' ||
    actual.result.state !== 'succeeded' ||
    !actual.result.text.includes(nonce)
  )
    throw new Error('Missing native assistant proof');
  Result.parse(actual.result);
  stage = 'independent-team-read';
  const response = outcome(Message).parse(
    (
      await client.callTool({
        name: 'team_message_get',
        arguments: {
          channelId: context.channelId,
          messageId: row.resultMessageId,
        },
      })
    ).structuredContent,
  ).result;
  if (
    !response.ok ||
    !response.data.body.startsWith(actual.result.text) ||
    response.data.sourceMessageId !== source.id ||
    response.data.sourceEventId !== event.fact.id ||
    response.data.author.kind !== 'agent' ||
    response.data.author.agentId !== context.agentId
  )
    throw new Error('Incorrect delivery');
  if (
    store.tasks.get(
      principal,
      context.teamId,
      context.channelId,
      context.taskId,
    ).state.status !== 'proposed'
  )
    throw new Error('Task acceptance changed');
  writeFileSync(
    join(directory, 'inbox-native-report.json'),
    JSON.stringify({
      version: 1,
      deliveryId,
      sourceEventId: event.fact.id,
      sourceMessageId: source.id,
      resultMessageId: row.resultMessageId,
      reference,
      itemId: actual.result.itemId,
      gate: 'real-native-mention-result',
      taskAcceptance: 'not-evaluated',
    }),
    { mode: 0o600, flag: 'wx' },
  );
  console.info(
    'INBOX_T3_NATIVE PASS: ordinary worker, real native run, exact-run assistant and attributed source-linked Team MCP result verified; no task acceptance.',
  );
} catch {
  console.error(
    'INBOX_T3_NATIVE FAIL at ' +
      stage +
      ': requires explicit opt-in, fresh disposable fixture, private worker binding, approved native OAuth and supported isolated Team MCP Provider.',
  );
  process.exitCode = 1;
} finally {
  if (worker?.exitCode === null && worker.signalCode === null) {
    try {
      const exited = once(worker, 'exit', {
        signal: AbortSignal.timeout(150000),
      });
      worker.kill('SIGTERM');
      await exited;
    } catch {
      worker.kill('SIGKILL');
      process.exitCode = 1;
    }
  }
  // A failed/uncertain launch can need operator inspection. Never delete its durable intent or claim cleanup success.
  if (deliveryId && store && !reference) {
    const row = store.inbox.get(deliveryId);
    if (row.reference) reference = Reference.parse(JSON.parse(row.reference));
    else if (row.launch !== null) {
      console.error(
        'INBOX_T3_NATIVE CLEANUP UNCERTAIN: retain the disposable fixture and inspect its native intent privately.',
      );
      process.exitCode = 1;
    }
  }
  if (reference && handle) {
    try {
      let observed = await handle.backend.read(reference);
      if (!observed.terminal) {
        await handle.backend.stop(reference, {
          actor: 'local-inbox-live-owner',
          operationKey: randomUUID(),
        });
        await handle.backend.wait(reference, 20000);
        observed = await handle.backend.read(reference);
      }
      if (!observed.terminal) throw new Error('Run still active');
      const config = loadWorkerConfig(process.env.KINMESH_INBOX_CONFIG ?? '');
      const binding = config.bindings[0];
      if (!binding) throw new Error('Missing binding');
      wire = new SdkWire(
        loadCredential(binding.t3AuthFile, binding.t3Endpoint),
      );
      const tools = new ValidatedTools(wire, await wire.list());
      await tools.call('t3_thread_organize', {
        threadId: reference.threadId,
        action: 'archive',
      });
    } catch {
      console.error(
        'INBOX_T3_NATIVE CLEANUP FAIL: inspect the disposable native run privately.',
      );
      process.exitCode = 1;
    }
  }
  await Promise.allSettled([wire?.close(), handle?.close(), client?.close()]);
  store?.close();
}
