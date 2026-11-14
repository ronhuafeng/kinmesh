import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { openStore } from '../src/persistence/store.js';
import { ProfileInput } from '../src/domain/agents.js';
import { LiveContext } from '../src/team-mcp/live-context.js';
import { TeamEndpoint } from '../src/team-mcp/client.js';
let store: ReturnType<typeof openStore> | undefined;
process.umask(0o077);
try {
  const c = z
    .object({
      KINMESH_TEAM_LIVE_DIR: z.string().min(1),
      KINMESH_TEAM_MCP_ENDPOINT: TeamEndpoint,
      KINMESH_TEAM_LIVE_SCENARIO: z.enum(['team', 'inbox']).default('team'),
      KINMESH_T3_ENVIRONMENT_ID: z.string().min(1).optional(),
      KINMESH_TEAM_T3_ISOLATED_PROVIDER: z.string().min(1).optional(),
      KINMESH_T3_MODEL: z.string().min(1).optional(),
    })
    .parse(process.env);
  const inbox = c.KINMESH_TEAM_LIVE_SCENARIO === 'inbox';
  if (
    inbox &&
    (!c.KINMESH_T3_ENVIRONMENT_ID ||
      !c.KINMESH_TEAM_T3_ISOLATED_PROVIDER ||
      !c.KINMESH_T3_MODEL)
  )
    throw new Error('Explicit Inbox native preferences required');
  const directory = resolve(c.KINMESH_TEAM_LIVE_DIR);
  if (
    dirname(directory) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('kinmesh-team-live-')
  )
    throw new Error('Disposable path required');
  mkdirSync(directory, { mode: 0o700 }); // Refuse overwrite, even after a failed partial preparation.
  const database = join(directory, 'team.sqlite');
  store = openStore(database);
  const humanId = (
    await store.signIn({
      feishuId: 'live-owner',
      email: 'live-owner@kinmesh.test',
    })
  ).id;
  await store.renameTeam(humanId, 'Disposable MCP acceptance');
  const team = await store.teamFor(humanId);
  if (!team) throw new Error('Team missing');
  const channelId = team.channels[0]?.id;
  if (!channelId) throw new Error('Channel missing');
  const p = { kind: 'human', humanId } as const;
  const profile = (name: string, role: 'developer' | 'reviewer') =>
    ProfileInput.parse({
      name,
      role,
      capabilities: [],
      preferences: inbox
        ? {
            environmentId: c.KINMESH_T3_ENVIRONMENT_ID,
            providerId: c.KINMESH_TEAM_T3_ISOLATED_PROVIDER,
            modelId: c.KINMESH_T3_MODEL,
          }
        : { environmentId: null, providerId: null, modelId: null },
      memoryLocation: null,
    });
  const developer = await store.agents.create(
    p,
    team.team.id,
    profile('Live Developer', 'developer'),
  );
  const reviewer = await store.agents.create(
    p,
    team.team.id,
    profile('Live Reviewer', 'reviewer'),
  );
  for (const a of [developer, reviewer])
    await store.communication.enroll(
      p,
      team.team.id,
      channelId,
      { operationKey: randomUUID(), member: { kind: 'agent', id: a.id } },
      'invite',
    );
  const grant = await store.agents.issue(p, team.team.id, developer.id, {
    label: 'Disposable provider MCP',
    scopes: [
      'channels:read',
      'channels:write',
      'tasks:read',
      'tasks:write',
      ...(inbox ? (['executions:read', 'executions:write'] as const) : []),
    ],
    lifetimeSeconds: 3600,
  });
  const tokenFile = join(directory, 'developer.json');
  writeFileSync(tokenFile, JSON.stringify({ token: grant.token }), {
    mode: 0o600,
    flag: 'wx',
  });
  const message = await store.communication.post(p, team.team.id, channelId, {
    operationKey: randomUUID(),
    body: 'kinmesh-read-proof-' + randomUUID(),
    topicId: null,
    mentions: [],
    sourceMessageId: null,
    sourceEventId: null,
  });
  const task = (
    await store.tasks.create(p, team.team.id, channelId, {
      operationKey: randomUUID(),
      title: 'Disposable provider responsibility',
      description: 'Use only Team MCP. No human acceptance.',
      criteria: ['Read, post, claim and reviewer handoff'],
      topicId: null,
      owner: null,
      reviewer: null,
      sourceMessageId: message.id,
      sourceEventId: null,
    })
  ).task;
  const context = LiveContext.parse({
    version: 1,
    database,
    endpoint: c.KINMESH_TEAM_MCP_ENDPOINT,
    humanId,
    teamId: team.team.id,
    channelId,
    agentId: developer.id,
    reviewerId: reviewer.id,
    taskId: task.id,
    sourceMessageId: message.id,
    tokenFile,
  });
  writeFileSync(join(directory, 'context.json'), JSON.stringify(context), {
    mode: 0o600,
    flag: 'wx',
  });
  console.info(
    'TEAM_PROVIDER_FIXTURE PASS: private context and expiring agent credential prepared in requested disposable directory.',
  );
} catch {
  console.error(
    'TEAM_PROVIDER_FIXTURE FAIL: requires a NEW /tmp/kinmesh-team-live-* directory and valid Team MCP endpoint.',
  );
  process.exitCode = 1;
} finally {
  await store?.close();
}
