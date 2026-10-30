import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { Delivery, Result } from '../src/domain/inbox.js';
import { Binding, WorkerConfig } from '../src/inbox/config.js';
import { T3Backend } from '../src/adapters/t3/backend.js';
import type { BackendFactory } from '../src/inbox/t3.js';
import { taskFixture } from './task-helpers.js';
import { profileInput } from './agent-helpers.js';
import {
  MockWire,
  mockRead,
  options,
  launch,
  reference,
} from './t3-helpers.js';
export function assistantRead(
  text = 'Fixture assistant output; no real model was invoked.',
  status = 'completed',
) {
  const data = mockRead(status);
  const assistant = data.items.find((i) => i.type === 'assistant_message');
  if (!assistant) throw new Error('Missing fixture assistant');
  return { ...data, items: [{ ...assistant, runId: reference.runId, text }] };
}
export const fixtureResult = () =>
  Result.parse({
    reference,
    itemId: 'fixture-item',
    text: 'Fixture assistant output; no real model was invoked.',
    truncated: false,
    state: 'succeeded',
  });
export function rows(path: string) {
  const raw = new Database(path);
  try {
    // Drizzle's mapping is reproduced only at this test inspection boundary.
    const columns = [
      'position',
      'id',
      'event_id eventId',
      'team_id teamId',
      'channel_id channelId',
      'agent_id agentId',
      'root_id rootId',
      'depth',
      'task_id taskId',
      'message_id messageId',
      'topic_id topicId',
      'state',
      'generation',
      'claim_token claimToken',
      'lease_until leaseUntil',
      'next_attempt nextAttempt',
      'attempts',
      'expires_at expiresAt',
      'launch',
      'operation_id operationId',
      'reference',
      'result_message_id resultMessageId',
      'reason',
    ];
    return z
      .array(Delivery)
      .parse(
        raw
          .prepare(
            'SELECT ' +
              columns.join(',') +
              ' FROM agent_inbox ORDER BY position',
          )
          .all(),
      );
  } finally {
    raw.close();
  }
}
export function due(path: string, expiredLease = false) {
  const raw = new Database(path);
  try {
    raw.exec(
      'UPDATE agent_inbox SET next_attempt=0' +
        (expiredLease
          ? ',lease_until=CASE WHEN claim_token IS NULL THEN 0 ELSE 1 END'
          : '') +
        " WHERE state NOT IN ('acked','expired')",
    );
  } finally {
    raw.close();
  }
}
export async function inboxFixture() {
  const f = await taskFixture();
  f.store.agents.update(f.principal, f.teamId, f.agent.id, {
    ...profileInput,
    preferences: {
      environmentId: reference.environmentId,
      providerId: launch.model.providerId,
      modelId: launch.model.modelId,
    },
  });
  const grant = f.store.agents.issue(f.principal, f.teamId, f.agent.id, {
    label: 'Disposable inbox test',
    scopes: [
      'agents:read',
      'channels:read',
      'channels:write',
      'tasks:read',
      'tasks:write',
      'tasks:review',
      'executions:read',
      'executions:write',
    ],
    lifetimeSeconds: 3600,
  });
  const tokenFile = join(f.directory, 'worker-agent.json');
  writeFileSync(tokenFile, JSON.stringify({ token: grant.token }), {
    mode: 0o600,
  });
  const binding = Binding.parse({
    agentId: f.agent.id,
    tokenFile,
    t3Endpoint: options.endpoint,
    t3AuthFile: join(f.directory, 'absent-t3-oauth.json'),
    isolatedProviderId: launch.model.providerId,
    externalTeamMcpConfigured: true,
  });
  const config = WorkerConfig.parse({
    database: f.dbPath,
    pollMs: 100,
    bindings: [binding],
  });
  const configPath = join(f.directory, 'worker.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const wire = new MockWire();
  wire.values.t3_thread_read = assistantRead();
  const factory: BackendFactory = async () => ({
    backend: await T3Backend.connect(wire, f.store.operations, options),
    identity: {
      endpoint: options.endpoint,
      environmentId: reference.environmentId,
      authority: options.authority,
    },
    close: () => wire.close(),
  });
  return {
    ...f,
    binding,
    workerConfig: config,
    configPath,
    inboxGrant: grant,
    workerPrincipal: f.store.agents.resolveToken(grant.token),
    wire,
    factory,
    inbox: f.store.inbox,
    rows: () => rows(f.dbPath),
  };
}
