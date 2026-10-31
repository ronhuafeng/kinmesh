import { test } from '@playwright/test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Native, Executor, models, roles } from './native.js';
import { Hub } from './hub.js';
import { until, ready } from './processes.js';
import { SdkWire } from '../../src/adapters/t3/sdk.js';
import { T3Backend } from '../../src/adapters/t3/backend.js';
import { authority } from '../../src/adapters/t3/oauth.js';
import {
  ValidatedTools,
  Capabilities,
  Read,
} from '../../src/adapters/t3/contracts.js';
import {
  Reference,
  ExecutionFailure,
  type Observation,
} from '../../src/domain/execution.js';
import { openStore } from '../../src/persistence/store.js';
import { assistantResult } from '../../src/inbox/worker.js';

const rowSchema = z.object({
  id: z.string(),
  event_id: z.string(),
  agent_id: z.string(),
  state: z.string(),
  generation: z.number(),
  lease_until: z.number().nullable(),
  reference: z.string().nullable(),
  result_message_id: z.string().nullable(),
});
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const record = z.record(z.string(), z.unknown());
const grants = z.object({
  result: z.object({
    ok: z.boolean(),
    error: z.object({ code: z.string() }).optional(),
  }),
});

test('complete real two-agent workflow, Human rework/acceptance, recovery and authority', async () => {
  process.umask(0o077);
  const executor = Executor.parse(process.env.KINMESH_LIVE_EXECUTOR);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kinmesh-live-')));
  const native = new Native(root, executor);
  const hub = new Hub(root, native);
  let db: Database.Database | undefined;
  let store: ReturnType<typeof openStore> | undefined;
  let wire: SdkWire | undefined;
  let backend: T3Backend | undefined;
  let tools: ValidatedTools | undefined;
  let stage = 'prepare';
  const evidence: Record<string, unknown> = {
    sourceCommit: process.env.GITHUB_SHA ?? 'local',
    executor,
    t3Version: '0.1.5',
    model: models[executor],
    scenario: 'complete-two-cycle-collaboration',
    simulatedHuman: true,
    realT3: true,
    realProvider: true,
    transport: 'official OAuth MCP',
    result: 'FAIL',
    plannedNativeRuns: 4,
    checks: {},
  };
  const checks: Record<string, boolean> = {};
  evidence.checks = checks;
  const rows = () => {
    if (!db) throw new Error('DATABASE_REQUIRED');
    return z
      .array(rowSchema)
      .parse(
        db
          .prepare('select *from agent_inbox where task_id=? order by position')
          .all(hub.taskId),
      );
  };
  async function auditNative() {
    if (!backend || !db) throw new Error('AUDIT_NOT_READY');
    const results = [];
    const runIds = new Set<string>();
    const requestIds = new Set<string>();
    for (const row of rows()) {
      assert.equal(row.state, 'acked');
      const ref = Reference.parse(
        JSON.parse(row.reference ?? 'null') as unknown,
      );
      const role = roles.find((r) => hub.agent(r).profile.id === row.agent_id);
      assert.ok(role);
      assert.ok(ref.runId);
      assert.ok(!runIds.has(ref.runId));
      runIds.add(ref.runId);
      if (!tools) throw new Error('NATIVE_AUDIT_REQUIRED');
      const activity = Read.parse(
        await tools.call('t3_thread_read', {
          threadId: ref.threadId,
          view: 'activity',
          limit: 100,
          runLimit: 50,
          maxCharsPerItem: 50000,
        }),
      );
      assert.equal(activity.hasMore, false);
      const successfulCalls = activity.items
        .filter(
          (item) => item.type === 'dynamic_tool' && item.runId === ref.runId,
        )
        .flatMap((item) => {
          assert.equal(item.textTruncated, false);
          const call = z
            .object({
              toolName: z.string(),
              input: record,
              output: z
                .object({
                  result: z.object({
                    ok: z.boolean(),
                    data: z.unknown().optional(),
                  }),
                })
                .optional(),
            })
            .parse(JSON.parse(item.text ?? 'null') as unknown);
          return call.output?.result.ok
            ? [
                {
                  name: call.toolName.replace(/^kinmesh\./, ''),
                  input: call.input,
                  data: call.output.result.data,
                },
              ]
            : [];
        });
      for (const name of [
        'team_task_get',
        'team_tasks_history',
        'team_messages_read',
        'team_messages_send',
        role === 'developer' ? 'team_task_handoff' : 'team_task_review',
      ]) {
        assert.ok(
          successfulCalls.some(
            (call) =>
              call.name === name && call.input.channelId === hub.channelId,
          ),
        );
      }
      if (role === 'reviewer') {
        const artifacts = successfulCalls
          .filter((call) => call.name === 'team_messages_read')
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
        const developerEvent = rows()[results.length - 1]?.event_id;
        assert.ok(
          artifacts.some(
            (message) =>
              message.author.agentId === hub.agent('developer').profile.id &&
              message.sourceEventId === developerEvent &&
              message.body.includes(hub.marker) &&
              message.body.includes('7 x 8 = 56') &&
              (results.length < 2 || message.body.includes('verified')),
          ),
        );
      }
      const observed: Observation = await backend.read(ref);
      assert.equal(observed.state, 'succeeded');
      assert.equal(observed.model.providerId, native.provider(role));
      assert.equal(observed.model.modelId, models[executor]);
      const actual = await assistantResult(
        backend,
        ref,
        observed.model,
        AbortSignal.timeout(30_000),
      );
      assert.equal(actual.kind, 'result');
      const saved = z
        .array(
          z.object({
            result: z.string(),
            message_id: z.string(),
            correlation_id: z.string(),
            task_link_id: z.string(),
          }),
        )
        .parse(
          db
            .prepare('select *from inbox_results where delivery_id=?')
            .all(row.id),
        );
      assert.equal(saved.length, 1);
      const savedResult = saved[0];
      assert.ok(savedResult);
      assert.deepEqual(
        JSON.parse(savedResult.result) as unknown,
        actual.result,
      );
      const message = z
        .object({
          author: z.string(),
          source_event_id: z.string(),
          body: z.string(),
        })
        .parse(
          db
            .prepare('select *from messages where id=?')
            .get(savedResult.message_id),
        );
      assert.equal(
        z
          .object({ agentId: z.string() })
          .parse(JSON.parse(message.author) as unknown).agentId,
        row.agent_id,
      );
      assert.equal(message.source_event_id, row.event_id);
      assert.ok(message.body.includes(actual.result.text));
      const op = z
        .object({
          phase: z.string(),
          request_id: z.string(),
          reference: z.string(),
        })
        .parse(
          db
            .prepare('select *from execution_operations where operation_key=?')
            .get('inbox:' + row.id),
        );
      assert.equal(op.phase, 'known');
      assert.ok(!requestIds.has(op.request_id));
      requestIds.add(op.request_id);
      assert.deepEqual(JSON.parse(op.reference) as unknown, ref);
      const association = z
        .object({ reference: z.string() })
        .parse(
          db
            .prepare('select *from agent_correlations where id=?')
            .get(savedResult.correlation_id),
        );
      assert.deepEqual(JSON.parse(association.reference) as unknown, ref);
      const link = z
        .object({ task_id: z.string() })
        .parse(
          db
            .prepare('select *from task_executions where id=?')
            .get(savedResult.task_link_id),
        );
      assert.equal(link.task_id, hub.taskId);
      results.push({
        role,
        eventDigest: hash(row.event_id),
        deliveryDigest: hash(row.id),
        runDigest: hash(JSON.stringify(ref)),
        requestDigest: hash(op.request_id),
        assistantDigest: hash(actual.result.text),
        nativeState: observed.state,
      });
    }
    evidence.executions = results;
    evidence.nativeRunCount = results.length;
    checks.nativeItemJournalAuthorSourceAndTaskMatch = true;
    checks.actualRoleToolCallsAndReviewerArtifactReads = true;
  }
  async function approve(row: z.infer<typeof rowSchema>) {
    if (!tools || !row.reference || !native.page) return;
    const ref = Reference.parse(JSON.parse(row.reference) as unknown);
    const activity = Read.parse(
      await tools.call('t3_thread_read', {
        threadId: ref.threadId,
        view: 'activity',
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: 20_000,
      }),
    );
    if (!activity.thread.pendingRequestCount) return;
    const role = roles.find((r) => hub.agent(r).profile.id === row.agent_id);
    assert.ok(role);
    const calls = activity.items.filter(
      (i) => i.type === 'dynamic_tool' && i.runId === ref.runId,
    );
    const call = calls.at(-1);
    if (!call?.text) throw new Error('NATIVE_APPROVAL_NOT_INSPECTABLE');
    const input = z
      .object({ toolName: z.string(), input: record })
      .parse(JSON.parse(call.text) as unknown);
    const tool = input.toolName.replace(/^kinmesh\./, '');
    assert.equal(input.input.channelId, hub.channelId);
    if (tool === 'team_messages_send') {
      assert.equal(input.input.sourceEventId, row.event_id);
      assert.deepEqual(input.input.mentions, []);
      assert.equal(typeof input.input.body, 'string');
    } else {
      assert.equal(input.input.taskId, hub.taskId);
      const task = await hub.task();
      assert.equal(input.input.expectedVersion, task.version);
      if (role === 'developer' && tool === 'team_task_handoff') {
        assert.equal(input.input.mode, 'review');
        assert.deepEqual(input.input.recipient, {
          kind: 'agent',
          id: hub.agent('reviewer').profile.id,
        });
      } else if (role === 'reviewer' && tool === 'team_task_review')
        assert.equal(input.input.decision, 'approve');
      else throw new Error('UNEXPECTED_NATIVE_WRITE');
    }
    assert.equal(typeof input.input.operationKey, 'string');
    const page = native.page;
    assert.ok(activity.thread.link);
    const target = new URL(activity.thread.link);
    assert.equal(target.origin, native.origin);
    if (page.url() !== target.href) await page.goto(target.href);
    await page
      .getByRole('button', { name: 'Approve', exact: true })
      .last()
      .click();
  }
  let crashed = false;
  let originalRequest = '';
  let originalLease = 0;
  async function progress(
    targetVersion: number,
    deliveries: number,
    injectCrash = false,
  ) {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const current = rows();
      for (const row of current) {
        if (row.state === 'blocked') throw new Error('INBOX_BLOCKED');
        if (row.state === 'acked' || !row.reference) continue;
        if (
          injectCrash &&
          !crashed &&
          row.agent_id === hub.agent('developer').profile.id
        ) {
          if (!db || !store) throw new Error('CRASH_NOT_READY');
          const op = z
            .object({ request_id: z.string() })
            .parse(
              db
                .prepare(
                  'select *from execution_operations where operation_key=?',
                )
                .get('inbox:' + row.id),
            );
          originalRequest = op.request_id;
          const processTable = execFileSync(
            'ps',
            ['-axo', 'pid=,ppid=,args='],
            { encoding: 'utf8' },
          )
            .split('\n')
            .flatMap((line) => {
              const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
              return m
                ? [
                    {
                      pid: Number(m[1]),
                      parent: Number(m[2]),
                      command: m[3] ?? '',
                    },
                  ]
                : [];
            });
          const owned = new Set([hub.process?.child?.pid]);
          for (let i = 0; i < 8; i++)
            for (const p of processTable)
              if (owned.has(p.parent)) owned.add(p.pid);
          const worker = processTable.find(
            (p) => owned.has(p.pid) && p.command.includes('src/inbox/main.ts'),
          );
          assert.ok(worker);
          const leaseDeadline = Date.now() + 60_000;
          while (Date.now() < leaseDeadline) {
            const candidate = rows().find(
              (candidate) => candidate.id === row.id,
            );
            if ((candidate?.lease_until ?? 0) > Date.now()) {
              process.kill(worker.pid, 'SIGSTOP');
              const paused = rows().find(
                (candidate) => candidate.id === row.id,
              );
              if ((paused?.lease_until ?? 0) > Date.now()) {
                originalLease = paused?.lease_until ?? 0;
                process.kill(worker.pid, 'SIGKILL');
                crashed = true;
                assert.equal(
                  store.inbox.claim([hub.agent('developer').profile.id]),
                  undefined,
                );
                checks.concurrentClaimFenced = true;
                break;
              }
              process.kill(worker.pid, 'SIGCONT');
            }
            await delay(10);
          }
          assert.ok(crashed, 'ACTIVE_WORKER_LEASE_NOT_CAPTURED');
          checks.actualWorkerKilledAfterNativeLaunch = true;
          await delay(1000);
        }
        await approve(row);
      }
      if (!db) throw new Error('DATABASE_REQUIRED');
      const task = z
        .object({ version: z.number(), state: z.string() })
        .parse(
          db
            .prepare('select version,state from tasks where id=?')
            .get(hub.taskId),
        );
      const taskState = z
        .object({ status: z.string() })
        .parse(JSON.parse(task.state) as unknown);
      if (
        task.version === targetVersion &&
        taskState.status === 'awaiting-human' &&
        current.length === deliveries &&
        current.every((r) => r.state === 'acked')
      )
        return;
      if (taskState.status === 'accepted')
        throw new Error('TASK_AUTO_ACCEPTED');
      await delay(2000);
    }
    throw new Error('COLLABORATION_NOT_TERMINAL');
  }
  try {
    stage = 'native-bootstrap';
    await native.start();
    stage = 'workspace-onboarding';
    await hub.start();
    await hub.startTeam();
    await hub.onboard();
    stage = 'native-provider-configuration';
    await native.addProviders();
    stage = 'native-oauth';
    const read = await native.oauth(true);
    const operate = await native.oauth(false);
    assert.ok(!read.tokens.scope?.split(' ').includes('orchestration:operate'));
    assert.ok(
      operate.tokens.scope?.split(' ').includes('orchestration:operate'),
    );
    checks.separateNativeOAuthScopes = true;
    store = openStore(hub.database);
    db = new Database(hub.database, { readonly: true });
    wire = new SdkWire(read);
    backend = await T3Backend.connect(wire, store.operations, {
      endpoint: native.endpoint,
      expectedEnvironmentId: read.environmentId,
      authority: authority(read),
      scopes: read.tokens.scope?.split(' ') ?? [],
    });
    tools = new ValidatedTools(wire, await wire.list());
    stage = 'native-capability-preflight';
    const liveTools = tools;
    await until(
      async () => {
        const capabilities = Capabilities.parse(
          await liveTools.call('orchestrator_capabilities', {}),
        );
        return roles.every((role) => {
          const provider = capabilities.providers.find(
            (p) => p.providerInstanceId === native.provider(role),
          );
          return (
            provider?.canRunChildTask === true &&
            !provider.constraints.length &&
            provider.models.some((m) => m.id === models[executor])
          );
        });
      },
      'CAPABILITIES_NOT_RUNNABLE',
      60_000,
    );
    checks.bothRealProvidersRunnable = true;
    try {
      await tools.call('t3_thread_organize', {
        threadId: randomUUID(),
        action: 'archive',
      });
      throw new Error('READ_ONLY_WRITE_ALLOWED');
    } catch (e) {
      if (!(e instanceof ExecutionFailure) || e.kind !== 'permission')
        throw new Error('NATIVE_READ_ONLY_DENIAL_MISSING');
    }
    checks.nativeReadOnlyMutationDenied = true;
    await hub.bind(read.environmentId);
    await hub.process?.stop();
    await hub.start(true);
    stage = 'first-workflow-and-worker-crash';
    await hub.createTask();
    if (!native.page) throw new Error('NO_NATIVE_PAGE');
    await native.page.goto(native.origin);
    await progress(3, 2, true);
    assert.equal(crashed, true);
    assert.ok(Date.now() >= originalLease);
    const first = rows()[0];
    assert.ok(first);
    assert.equal(
      z
        .object({ request_id: z.string() })
        .parse(
          db
            .prepare('select *from execution_operations where operation_key=?')
            .get('inbox:' + first.id),
        ).request_id,
      originalRequest,
    );
    checks.workerRecoveryRetainsOriginalNativeRequest = true;
    stage = 'repeated-human-source';
    assert.ok(hub.createdInput);
    await hub.api(
      `/api/teams/${hub.teamId}/channels/${hub.channelId}/tasks`,
      hub.createdInput,
    );
    await hub.api(
      `/api/teams/${hub.teamId}/channels/${hub.channelId}/tasks`,
      hub.createdInput,
    );
    assert.equal(rows().length, 2);
    checks.sourceReplayDoesNotDuplicateDelivery = true;
    stage = 'agent-human-boundary';
    const developer = hub.agent('developer');
    const denied = await fetch(
      `${hub.origin}/api/teams/${hub.teamId}/channels/${hub.channelId}/tasks/${hub.taskId}/accept`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + developer.token,
          'content-type': 'application/json',
          'X-Kinmesh-Actor': hub.humanId,
        },
        body: JSON.stringify({
          operationKey: randomUUID(),
          expectedVersion: 3,
          note: 'Agent must not accept',
        }),
      },
    );
    assert.equal(denied.status, 403);
    assert.equal((await hub.task()).state.status, 'awaiting-human');
    checks.agentCannotImpersonateHumanAcceptance = true;
    stage = 't3-outage-and-human-rework';
    await native.server?.stop();
    await hub.decision('rework');
    await until(() => rows().length === 3, 'REWORK_NOT_ENQUEUED');
    await delay(2000);
    assert.equal(rows()[2]?.result_message_id, null);
    native.server?.start();
    await ready(native.origin + '/.well-known/t3/environment');
    await progress(6, 4);
    checks.nativeOutageRetainsAndResumesHumanRework = true;
    await auditNative();
    stage = 'rework-artifact-and-independent-review';
    const authored = z
      .array(z.object({ author: z.string(), body: z.string() }))
      .parse(
        db
          .prepare(
            'select author,body from messages where channel_id=? order by position',
          )
          .all(hub.channelId),
      );
    const artifacts = authored.filter(
      (m) =>
        z
          .object({ kind: z.string(), agentId: z.string().optional() })
          .parse(JSON.parse(m.author) as unknown).agentId ===
          developer.profile.id && m.body.includes(hub.marker),
    );
    assert.ok(
      artifacts.some((m) => m.body.includes('7 x 8 = 56')) &&
        artifacts.some((m) => m.body.includes('verified')),
    );
    checks.actualReworkArtifactPresent = true;
    stage = 'hub-restart';
    const before = JSON.stringify(await hub.task());
    await hub.process?.stop();
    await hub.start(true);
    assert.equal(JSON.stringify(await hub.task()), before);
    assert.equal(rows().length, 4);
    checks.hubRestartRetainsTaskAndNativeCorrelations = true;
    stage = 'human-acceptance';
    await hub.decision('accept');
    await until(
      async () => (await hub.task()).state.status === 'accepted',
      'HUMAN_ACCEPTANCE_NOT_RECORDED',
    );
    assert.equal((await hub.task()).version, 7);
    const events = z
      .array(z.object({ event: z.string() }))
      .parse(
        db
          .prepare(
            'select event from task_events where task_id=? order by position',
          )
          .all(hub.taskId),
      )
      .map((e) =>
        z
          .object({
            action: z.string(),
            author: z.object({
              kind: z.string(),
              humanId: z.string().optional(),
            }),
          })
          .parse(JSON.parse(e.event) as unknown),
      );
    assert.equal(
      events.filter(
        (e) =>
          e.action === 'rework' &&
          e.author.kind === 'human' &&
          e.author.humanId === hub.humanId,
      ).length,
      1,
    );
    assert.equal(
      events.filter(
        (e) =>
          e.action === 'accept' &&
          e.author.kind === 'human' &&
          e.author.humanId === hub.humanId,
      ).length,
      1,
    );
    checks.simulatedHumanReworkAndAcceptanceAudited = true;
    stage = 'real-native-workspace';
    const page = hub.page;
    assert.ok(page);
    await page.getByRole('tab', { name: 'Agents & activity' }).click();
    await page
      .getByRole('button', { name: 'View CI developer activity' })
      .click();
    await page
      .getByRole('button', { name: 'Check native status', exact: true })
      .first()
      .click();
    const link = page
      .getByRole('link', { name: 'Open verified T3 thread', exact: true })
      .first();
    await link.waitFor();
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const popup = await popupPromise;
    await popup.getByRole('heading', { name: /^Kinmesh inbox / }).waitFor();
    await popup.close();
    checks.realNativeObserverAndAuthenticatedThreadLink = true;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
    }
    checks.realResponsiveWorkspace = true;
    stage = 'cross-channel-authority';
    const hidden = z.object({ id: z.string() }).parse(
      await hub.api(`/api/teams/${hub.teamId}/channels`, {
        operationKey: randomUUID(),
        name: 'private',
      }),
    );
    const client = new Client({ name: 'kinmesh-live-authority', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(hub.teamOrigin + '/mcp'), {
          requestInit: {
            headers: { authorization: 'Bearer ' + developer.token },
          },
        }),
      );
      const response = await client.callTool({
        name: 'team_messages_read',
        arguments: { channelId: hidden.id, limit: 10 },
      });
      const envelope = z
        .object({
          structuredContent: z.unknown().optional(),
          content: z.array(
            z.object({ type: z.string(), text: z.string().optional() }),
          ),
        })
        .parse(response);
      const raw =
        envelope.structuredContent ??
        (JSON.parse(
          envelope.content.find((c) => c.type === 'text')?.text ?? 'null',
        ) as unknown);
      const outcome = grants.parse(raw);
      assert.equal(outcome.result.ok, false);
      assert.equal(outcome.result.error?.code, 'forbidden');
    } finally {
      await client.close();
    }
    checks.realTeamMcpCrossChannelDenied = true;
    stage = 'grant-revocation';
    await hub.api(
      `/api/teams/${hub.teamId}/agents/${developer.profile.id}/grants/${developer.grant.id}/revoke`,
      {},
    );
    assert.equal(
      (
        await fetch(hub.teamOrigin + '/mcp', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + developer.token },
        })
      ).status,
      401,
    );
    checks.realAgentGrantRevocationDenied = true;
    await auditNative();
    assert.equal(rows().length, 4);
    checks.fourUniqueNativeResults = true;
    evidence.result = 'PASS';
  } catch (error) {
    evidence.failedStage = stage;
    evidence.nativeSetupStage = native.stage;
    evidence.errorClass = error instanceof Error ? error.name : 'Unknown';
    if (error instanceof Error) {
      evidence.sourceFrames = [
        ...(error.stack ?? '').matchAll(/tests\/live\/[a-z.-]+\.ts:\d+:\d+/g),
      ].map((m) => m[0]);
      if (/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message))
        evidence.safeErrorCode = error.message;
    }
    // Raw errors, prompts, tool traffic and credential-bearing browser state stay private.
    throw new Error('LIVE_COLLABORATION_FAILED_AT_' + stage);
  } finally {
    if (db) {
      evidence.correlatedNativeRuns = new Set(
        rows().flatMap((row) => (row.reference ? [row.reference] : [])),
      ).size;
      evidence.ackedDeliveries = rows().filter(
        (row) => row.state === 'acked',
      ).length;
    }
    const wireClosed = await Promise.allSettled([wire?.close()]);
    store?.close();
    db?.close();
    const hubCleanup = await hub.close();
    const nativeClosed = await Promise.allSettled([native.close()]);
    const cleanupPassed =
      hubCleanup.grantsRevoked &&
      hubCleanup.servicesStopped &&
      [...wireClosed, ...nativeClosed].every(
        (result) => result.status === 'fulfilled',
      );
    evidence.cleanup = {
      ...hubCleanup,
      nativeStopped: nativeClosed.every(
        (result) => result.status === 'fulfilled',
      ),
      privateStateUploaded: false,
    };
    if (!cleanupPassed) evidence.result = 'FAIL';
    if (evidence.result === 'PASS')
      rmSync(root, { recursive: true, force: true });
    mkdirSync('.live-evidence', { recursive: true });
    writeFileSync(
      join('.live-evidence', executor + '.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    if (!cleanupPassed) throw new Error('LIVE_CLEANUP_FAILED');
  }
});
