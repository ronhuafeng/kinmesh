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
import {
  Activity,
  approvalCandidates,
  completedCalls,
  reviewProof,
  identityLinks,
} from './proof.js';
import { until, ready } from './processes.js';
import { SdkWire } from '../../src/adapters/t3/sdk.js';
import { T3Backend } from '../../src/adapters/t3/backend.js';
import { authority, type Credential } from '../../src/adapters/t3/oauth.js';
import {
  ValidatedTools,
  Capabilities,
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
    sourceCommit:
      process.env.GITHUB_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeDirty:
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
      }).trim().length > 0,
    releaseEvidence: process.env.GITHUB_ACTIONS === 'true',
    executor,
    t3Version: '0.1.5',
    providerVersion: executor === 'codex' ? '0.166.0' : '1.0.70',
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
  async function connectRead(credential: Credential) {
    if (!store) throw new Error('STORE_REQUIRED');
    await wire?.close();
    wire = new SdkWire(credential);
    backend = await T3Backend.connect(wire, store.operations, {
      endpoint: native.endpoint,
      expectedEnvironmentId: credential.environmentId,
      authority: authority(credential),
      scopes: credential.tokens.scope?.split(' ') ?? [],
    });
    tools = new ValidatedTools(wire, await wire.list());
  }
  async function activityFor(ref: Reference): Promise<Activity> {
    if (!tools) throw new Error('NATIVE_AUDIT_REQUIRED');
    const items: Activity['items'] = [];
    let after: number | undefined;
    for (let page = 0; page < 8; page++) {
      const activity = Activity.parse(
        await tools.call('t3_thread_read', {
          threadId: ref.threadId,
          view: 'activity',
          limit: 100,
          runLimit: 50,
          maxCharsPerItem: 50000,
          ...(after === undefined ? {} : { afterPosition: after }),
        }),
      );
      assert.equal(activity.thread.threadId, ref.threadId);
      items.push(...activity.items);
      if (!activity.hasMore) return { ...activity, items };
      assert.ok(
        activity.nextPosition !== null &&
          (after === undefined || activity.nextPosition > after),
      );
      after = activity.nextPosition;
    }
    throw new Error('NATIVE_ACTIVITY_EVIDENCE_PAGE_BOUND');
  }
  const reviewWitnesses = new Set<string>();
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
      const activity = await activityFor(ref);
      const successfulCalls = completedCalls(activity, ref.runId);
      for (const name of [
        'team_task_get',
        'team_tasks_history',
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
      assert.ok(
        successfulCalls.some(
          (call) =>
            ['team_messages_read', 'team_message_get'].includes(call.name) &&
            call.input.channelId === hub.channelId,
        ),
      );
      const decisionIndex = successfulCalls.findIndex(
        (call) =>
          call.name ===
            (role === 'developer' ? 'team_task_handoff' : 'team_task_review') &&
          call.input.taskId === hub.taskId &&
          call.input.channelId === hub.channelId,
      );
      assert.ok(decisionIndex >= 0);
      const beforeDecision = successfulCalls.slice(0, decisionIndex);
      for (const name of ['team_task_get', 'team_tasks_history'])
        assert.ok(
          beforeDecision.some(
            (call) =>
              call.name === name &&
              call.input.taskId === hub.taskId &&
              call.input.channelId === hub.channelId,
          ),
        );
      if (role === 'reviewer')
        assert.ok(
          reviewWitnesses.has(ref.runId),
          'REVIEW_PREAPPROVAL_WITNESS_MISSING',
        );
      const publications = successfulCalls.filter(
        (call) => call.name === 'team_messages_send',
      );
      const actionIds = new Map<string, string>();
      const publishedIds = new Set<string>();
      for (const publication of publications) {
        const id = z.object({ id: z.string() }).parse(publication.data).id;
        const action = JSON.stringify({
          channelId: publication.input.channelId,
          body: publication.input.body,
          mentions: publication.input.mentions,
          topicId: publication.input.topicId,
          sourceMessageId: publication.input.sourceMessageId,
          sourceEventId: publication.input.sourceEventId,
        });
        assert.ok(
          !actionIds.has(action) || actionIds.get(action) === id,
          'DUPLICATE_NATIVE_PUBLICATION',
        );
        actionIds.set(action, id);
        publishedIds.add(id);
      }
      const storedPublications = z
        .array(z.object({ id: z.string() }))
        .parse(
          db
            .prepare(
              "select id from messages where source_event_id=? and json_extract(author,'$.agentId')=? and id<>?",
            )
            .all(row.event_id, row.agent_id, row.result_message_id),
        );
      assert.deepEqual(
        new Set(storedPublications.map((message) => message.id)),
        publishedIds,
      );
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
      identityLinks(
        db
          .prepare('select *from agent_correlations where id=?')
          .get(savedResult.correlation_id),
        db
          .prepare('select *from task_executions where id=?')
          .get(savedResult.task_link_id),
        {
          teamId: hub.teamId,
          agentId: row.agent_id,
          taskId: hub.taskId,
          reference: ref,
        },
      );
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
    assert.ok(ref.runId);
    const activity = await activityFor(ref);
    if (!activity.thread.pendingRequestCount) return;
    assert.equal(activity.thread.activeRunId, ref.runId);
    assert.equal(activity.thread.latestRunId, ref.runId);
    const role = roles.find(
      (role) => hub.agent(role).profile.id === row.agent_id,
    );
    assert.ok(role);
    const { requests: pending, calls } = approvalCandidates(
      activity,
      ref.runId,
      activity.thread.pendingRequestCount,
    );
    // Validate all pending inputs before approving even one concurrent request.
    for (const call of calls) {
      const tool = call.name;
      assert.equal(call.input.channelId, hub.channelId);
      if (
        role === 'reviewer' &&
        (tool === 'team_task_review' ||
          (tool === 'team_messages_send' && !reviewWitnesses.has(ref.runId)))
      ) {
        const index = rows().findIndex((candidate) => candidate.id === row.id);
        reviewProof(activity, ref.runId, {
          channelId: hub.channelId,
          taskId: hub.taskId,
          developerId: hub.agent('developer').profile.id,
          developerEventId: rows()[index - 1]?.event_id ?? '',
          humanId: hub.humanId,
          marker: hub.marker,
          rework: index >= 2,
          reworkNote: hub.reworkNote,
        });
      }
      if (
        [
          'team_message_get',
          'team_messages_read',
          'team_task_get',
          'team_tasks_history',
        ].includes(tool)
      ) {
        if (tool.startsWith('team_task'))
          assert.equal(call.input.taskId, hub.taskId);
      } else if (tool === 'team_messages_send') {
        assert.equal(call.input.sourceEventId, row.event_id);
        assert.deepEqual(call.input.mentions, []);
        assert.equal(typeof call.input.body, 'string');
      } else {
        assert.equal(call.input.taskId, hub.taskId);
        assert.equal(call.input.expectedVersion, (await hub.task()).version);
        if (role === 'developer' && tool === 'team_task_handoff') {
          assert.equal(call.input.mode, 'review');
          assert.deepEqual(call.input.recipient, {
            kind: 'agent',
            id: hub.agent('reviewer').profile.id,
          });
        } else if (role === 'reviewer' && tool === 'team_task_review') {
          assert.equal(call.input.decision, 'approve');
          reviewWitnesses.add(ref.runId);
          evidence.readWitnesses = [...reviewWitnesses].map((runId) =>
            hash(runId),
          );
        } else throw new Error('UNEXPECTED_NATIVE_WRITE');
      }
      if (
        [
          'team_messages_send',
          'team_task_handoff',
          'team_task_review',
        ].includes(tool)
      )
        assert.equal(typeof call.input.operationKey, 'string');
    }
    const page = native.page;
    assert.ok(activity.thread.link);
    const target = new URL(activity.thread.link);
    assert.equal(target.origin, native.origin);
    if (page.url() !== target.href) await page.goto(target.href);
    // These are public T3 0.1.5 UI attributes. Each card closes over its own runtime request ID.
    const cards = page.locator('[data-v2-item-type="approval_request"]');
    await until(
      async () => (await cards.count()) === pending.length,
      'NATIVE_APPROVAL_CARDS_NOT_SYNCHRONIZED',
      10_000,
    );
    for (const card of await cards.all()) {
      assert.ok(
        [
          'App access approval',
          'App permission approval',
          ...(executor === 'grok' ? ['Command approval'] : []),
        ].includes((await card.getAttribute('aria-label')) ?? ''),
      );
      const detail = await card
        .locator('[data-approval-detail="complete"]')
        .innerText();
      assert.ok(
        pending.some(
          (request) =>
            request.text === detail || request.text?.startsWith(detail + '\n'),
        ),
      );
    }
    const detail = await cards
      .first()
      .locator('[data-approval-detail="complete"]')
      .innerText();
    const checked = cards.filter({ hasText: detail }).first();
    const button = checked.getByRole('button', {
      name: 'Approve',
      exact: true,
    });
    await button.waitFor();
    assert.equal(await button.count(), 1);
    await button.click();
  }
  let crashed = false;
  let originalRequest = '';
  let originalLease = 0;
  let originalReference = '';
  let originalGeneration = 0;
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
                originalReference = paused?.reference ?? '';
                originalGeneration = paused?.generation ?? 0;
                assert.ok(originalReference);
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
    if (process.env.GITHUB_ACTIONS === 'true') {
      assert.equal(evidence.workingTreeDirty, false);
      assert.equal(
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        process.env.GITHUB_SHA,
      );
    }
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
    await connectRead(read);
    assert.ok(tools);
    assert.ok(backend);
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
    assert.deepEqual(
      JSON.parse(first.reference ?? 'null') as unknown,
      JSON.parse(originalReference) as unknown,
    );
    assert.ok(first.generation > originalGeneration);
    const recoveredReference = Reference.parse(
      JSON.parse(originalReference) as unknown,
    );
    assert.equal((await backend.read(recoveredReference)).state, 'succeeded');
    evidence.recoveredOriginalRunDigest = hash(originalReference);
    checks.workerRecoveryRetainsOriginalNativeRun = true;
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
    const acceptanceUrl = `${hub.origin}/api/teams/${hub.teamId}/channels/${hub.channelId}/tasks/${hub.taskId}/accept`;
    for (const spoof of [false, true]) {
      const denied = await fetch(acceptanceUrl, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + developer.token,
          'content-type': 'application/json',
          ...(spoof ? { 'X-Kinmesh-Actor': hub.humanId } : {}),
        },
        body: JSON.stringify({
          operationKey: randomUUID(),
          expectedVersion: 3,
          note: 'Agent must not accept',
        }),
      });
      assert.equal(denied.status, spoof ? 400 : 403);
    }
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
    await connectRead(read);
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
      assert.equal(outcome.result.error?.code, 'not_found');
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
    for (const [table, expected] of [
      ['tasks', 1],
      ['agent_inbox', 4],
      ['inbox_results', 4],
      ['execution_operations', 4],
      ['task_executions', 4],
    ] as const) {
      const count = z
        .object({ n: z.number() })
        .parse(db.prepare('select count(*) as n from ' + table).get());
      assert.equal(count.n, expected);
    }
    checks.noExtraFixtureTasksDeliveriesOrNativeIntents = true;
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
    if (error instanceof ExecutionFailure) evidence.failureKind = error.kind;
    try {
      if (tools && db) {
        const inspector = tools;
        evidence.nativeDiagnostics = await Promise.all(
          rows()
            .filter((row) => row.reference)
            .map(async (row) => {
              const ref = Reference.parse(
                JSON.parse(row.reference ?? 'null') as unknown,
              );
              try {
                const snapshot = Activity.parse(
                  await inspector.call(
                    't3_thread_read',
                    {
                      threadId: ref.threadId,
                      view: 'activity',
                      limit: 100,
                      maxCharsPerItem: 512,
                    },
                    AbortSignal.timeout(5000),
                  ),
                );
                return {
                  runDigest: hash(JSON.stringify(ref)),
                  deliveryState: row.state,
                  nativeState: snapshot.thread.status,
                  pendingRequests: snapshot.thread.pendingRequestCount,
                  items: snapshot.items.slice(-15).map((item) => ({
                    type: item.type,
                    status: item.status,
                    truncated: item.textTruncated,
                    teamTool:
                      /"toolName"\s*:\s*"(?:kinmesh\.|kinmesh__)(team_[a-z_]+)"/.exec(
                        item.text ?? '',
                      )?.[1] ?? null,
                  })),
                };
              } catch {
                return {
                  runDigest: hash(JSON.stringify(ref)),
                  inspection: 'unavailable',
                };
              }
            }),
        );
      }
    } catch {
      evidence.nativeDiagnosticRead = 'unavailable';
    }
    // Raw errors, prompts, tool traffic and credential-bearing browser state stay private.
    throw new Error('LIVE_COLLABORATION_FAILED_AT_' + stage);
  } finally {
    const cleanupIssues: string[] = [];
    try {
      if (db) {
        const current = rows();
        evidence.correlatedNativeRuns = new Set(
          current.flatMap((row) => (row.reference ? [row.reference] : [])),
        ).size;
        evidence.ackedDeliveries = current.filter(
          (row) => row.state === 'acked',
        ).length;
      }
    } catch {
      cleanupIssues.push('FINAL_DATABASE_READ_FAILED');
    }
    for (const close of [() => store?.close(), () => db?.close()]) {
      try {
        close();
      } catch {
        cleanupIssues.push('DATABASE_CLOSE_FAILED');
      }
    }
    const [hubOutcome] = await Promise.allSettled([hub.close()]);
    const hubCleanup =
      hubOutcome.status === 'fulfilled'
        ? hubOutcome.value
        : { grantsRevoked: false, servicesStopped: false };
    const nativeClosed = await Promise.allSettled([
      native.close(),
      wire?.close(),
    ]);
    let cleanupPassed =
      hubCleanup.grantsRevoked &&
      hubCleanup.servicesStopped &&
      cleanupIssues.length === 0 &&
      nativeClosed.every((result) => result.status === 'fulfilled');
    evidence.cleanup = {
      ...hubCleanup,
      nativeErrors: native.cleanupErrors,
      issues: cleanupIssues,
      nativeStopped: nativeClosed[0].status === 'fulfilled',
      privateStateUploaded: false,
    };
    if (!cleanupPassed) evidence.result = 'FAIL';
    if (evidence.result === 'PASS') {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        cleanupIssues.push('PRIVATE_STATE_REMOVAL_FAILED');
        cleanupPassed = false;
        evidence.result = 'FAIL';
      }
    }
    mkdirSync('.live-evidence', { recursive: true });
    writeFileSync(
      join('.live-evidence', executor + '.json'),
      JSON.stringify(evidence, null, 2) + '\n',
    );
    if (!cleanupPassed && !evidence.failedStage)
      throw new Error('LIVE_CLEANUP_FAILED');
  }
});
