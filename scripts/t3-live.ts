import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  loadCredential,
  authority,
  Endpoint,
} from '../src/adapters/t3/oauth.js';
import { SdkWire } from '../src/adapters/t3/sdk.js';
import { nativeReadOnlyDenial } from './t3-native-denial.js';
import { ValidatedTools, type Wire } from '../src/adapters/t3/contracts.js';
import { T3Backend } from '../src/adapters/t3/backend.js';
import { openStore } from '../src/persistence/store.js';
import {
  type Reference,
  type Dispatch,
  type Intent,
  type Launch,
} from '../src/domain/execution.js';

process.umask(0o077);
const Config = z.object({
  KINMESH_T3_LIVE: z.literal('1'),
  KINMESH_T3_ENDPOINT: Endpoint,
  KINMESH_T3_AUTH_FILE: z.string().min(1),
  KINMESH_T3_READ_AUTH_FILE: z.string().min(1),
  KINMESH_T3_MODEL: z.string().min(1),
  KINMESH_T3_PROVIDER: z.string().min(1),
  KINMESH_T3_LIVE_DATABASE: z.string().min(1),
  KINMESH_T3_LIVE_REPORT: z.string().min(1),
});
function known(value: Dispatch): Reference {
  if (value.kind !== 'known') throw new Error('Uncertain dispatch');
  return value.reference;
}
function check(condition: boolean, name: string) {
  if (!condition) throw new Error('Live gate failed');
  console.info(name + ' PASS');
}
let store: ReturnType<typeof openStore> | undefined;
let wire: SdkWire | undefined;
let readWire: SdkWire | undefined;
let tools: ValidatedTools | undefined;
const disposableThreads = new Set<string>();
const passed: string[] = [];
try {
  const config = Config.parse(process.env);
  const credential = loadCredential(
    config.KINMESH_T3_AUTH_FILE,
    config.KINMESH_T3_ENDPOINT,
  );
  const readonly = loadCredential(
    config.KINMESH_T3_READ_AUTH_FILE,
    config.KINMESH_T3_ENDPOINT,
  );
  if (readonly.tokens.scope !== 'orchestration:read')
    throw new Error('Read-only grant required');
  store = openStore(config.KINMESH_T3_LIVE_DATABASE);
  wire = new SdkWire(credential);
  readWire = new SdkWire(readonly);
  const options = {
    endpoint: credential.endpoint,
    expectedEnvironmentId: credential.environmentId,
    authority: authority(credential),
    scopes: credential.tokens.scope?.split(' ') ?? [],
  };
  const backend = await T3Backend.connect(wire, store.operations, options);
  tools = new ValidatedTools(wire, await wire.list());
  const base = {
    target: { kind: 'scratch' },
    title: 'Disposable Kinmesh external MCP acceptance',
    model: {
      providerId: config.KINMESH_T3_PROVIDER,
      modelId: config.KINMESH_T3_MODEL,
    },
    mode: 'approval-required',
  } satisfies Launch;
  const nonce = 'KINMESH_' + randomUUID();
  const intent = { actor: 'local-live-owner', operationKey: randomUUID() };
  const reference = known(
    await backend.launch(
      {
        ...base,
        message:
          'Do not use tools, read files, edit files, or request approvals. Reply with exactly this text and nothing else: ' +
          nonce,
      },
      intent,
    ),
  );
  disposableThreads.add(reference.threadId);
  check(reference.runId !== undefined, 'LIVE_MCP_LAUNCH');
  passed.push('launch');
  check(
    known(
      await backend.launch(
        {
          ...base,
          message:
            'Do not use tools, read files, edit files, or request approvals. Reply with exactly this text and nothing else: ' +
            nonce,
        },
        intent,
      ),
    ).threadId === reference.threadId,
    'LIVE_PERSISTED_KEY_REUSE',
  );
  let completed = false;
  for (let i = 0; i < 12; i++) {
    const result = await backend.wait(reference, 20000);
    if (result.kind === 'observed' && result.observation.terminal) {
      completed = result.observation.state === 'succeeded';
      break;
    }
  }
  const observation = await backend.read(reference);
  check(
    completed &&
      observation.history.some(
        (i) =>
          i.type === 'assistant_message' &&
          i.runId === reference.runId &&
          i.text === nonce &&
          !i.truncated,
      ) &&
      observation.pendingRequests === 0 &&
      observation.model.providerId === config.KINMESH_T3_PROVIDER &&
      observation.model.modelId === config.KINMESH_T3_MODEL,
    'LIVE_EXACT_COMPLETION',
  );
  passed.push('completion');
  const follow = known(
    await backend.send(
      reference,
      'Do not use tools or files. Reply in at most 200 characters, including spaces and punctuation. Include this text: ' +
        nonce +
        '.',
      { actor: intent.actor, operationKey: randomUUID() },
    ),
  );
  const active = await backend.read(follow);
  check(active.state === 'active', 'LIVE_FOLLOWUP_ACTIVE');
  const stop = await backend.stop(follow, {
    actor: intent.actor,
    operationKey: randomUUID(),
  });
  check(stop.kind !== 'uncertain', 'LIVE_INTERRUPT_ACK');
  let stopped = await backend.read(follow);
  for (let i = 0; i < 12 && !stopped.terminal; i++) {
    await backend.wait(follow, 20000);
    stopped = await backend.read(follow);
  }
  check(
    stopped.state === 'stopped' && stopped.terminal,
    'LIVE_INTERRUPT_RECONCILED',
  );
  passed.push('send', 'active-interrupt');
  // Deliberately lose a real successful idle-launch reply. No fake backend or fake native runtime.
  let lostReference: string | undefined;
  const loseReply: Wire = {
    list: () =>
      wire === undefined ? Promise.reject(new Error('closed')) : wire.list(),
    close: () => Promise.resolve(),
    call: async (name, args, signal, timeout) => {
      if (wire === undefined) throw new Error('closed');
      const result = await wire.call(name, args, signal, timeout);
      if (name === 't3_thread_launch') {
        const envelope = z
          .object({ structuredContent: z.object({ threadId: z.string() }) })
          .parse(result);
        lostReference = envelope.structuredContent.threadId;
        disposableThreads.add(lostReference);
        throw new Error('Injected lost reply');
      }
      return result;
    },
  };
  const unreliable = await T3Backend.connect(
    loseReply,
    store.operations,
    options,
  );
  const recoveryIntent: Intent = {
    actor: intent.actor,
    operationKey: randomUUID(),
  };
  const uncertain = await unreliable.launch(base, recoveryIntent);
  check(uncertain.kind === 'uncertain', 'LIVE_LOST_REPLY_UNCERTAIN');
  if (uncertain.kind !== 'uncertain') throw new Error('Expected uncertain');
  await wire.close();
  store.close();
  store = openStore(config.KINMESH_T3_LIVE_DATABASE);
  const reopened = await T3Backend.connect(wire, store.operations, options);
  const reconciled = known(
    await reopened.reconcile(recoveryIntent, uncertain.operationId),
  );
  check(
    reconciled.threadId === lostReference &&
      (await reopened.read(reconciled)).state === 'idle',
    'LIVE_RESTART_SAME_KEY_RECONCILIATION',
  );
  passed.push('lost-reply', 'journal-restart', 'same-key-reconciliation');
  // Prove the T3 server itself rejects a Read only mutation. Do not ask
  // tools/list for the operating tool: a scope-filtered grant may hide it.
  // A random nonexistent ID is non-destructive even if authorization regresses.
  check(await nativeReadOnlyDenial(readWire), 'LIVE_NATIVE_PERMISSION_DENIAL');
  passed.push('native-permission-denial');
  mkdirSync(dirname(config.KINMESH_T3_LIVE_REPORT), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    config.KINMESH_T3_LIVE_REPORT,
    JSON.stringify({
      version: '0.1.5',
      transport: 'official-sdk-streamable-http-oauth',
      approval:
        'owner-approved-external-oauth; consent UX not inferred by this gate',
      passed,
      model: config.KINMESH_T3_MODEL,
      provider: config.KINMESH_T3_PROVIDER,
      threadCount: disposableThreads.size,
      modelTurns: 2,
    }),
    { mode: 0o600 },
  );
  console.info('T3_LIVE_GATE PASS');
} catch {
  console.error(
    'T3_LIVE_GATE FAIL: auth, endpoint, compatibility or live assertion missing/failed. No live acceptance claimed.',
  );
  process.exitCode = 1;
} finally {
  for (const threadId of disposableThreads) {
    try {
      await tools?.call('t3_thread_organize', { threadId, action: 'archive' });
    } catch {
      console.error(
        'LIVE_CLEANUP FAIL: disposable thread may need owner archival.',
      );
      process.exitCode = 1;
    }
  }
  await wire?.close();
  await readWire?.close();
  store?.close();
}
