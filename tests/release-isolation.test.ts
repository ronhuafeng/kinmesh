import { test } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  linkSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveContext } from '../src/team-mcp/live-context.js';
import { openStore } from '../src/persistence/store.js';
import { loadAgentToken } from '../src/team-mcp/client.js';
import { type Credential } from '../src/adapters/t3/oauth.js';
import { Capabilities } from '../src/adapters/t3/contracts.js';
import {
  loadReleasePlan,
  releasePlanFromEnvironment,
  ReleaseConfig,
} from '../scripts/release-live-config.js';
import {
  runRelease,
  runStage,
  probeNative,
  probeTeam,
} from '../scripts/release-live-runner.js';
import { MockWire, environment, options } from './t3-helpers.js';
import { freePort, startTeam, stop } from './team-mcp-helpers.js';

function put(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}
function prepare(directory: string, inbox: boolean, endpoint: string) {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/team-live-prepare.ts'],
    {
      env: {
        PATH: process.env.PATH,
        KINMESH_TEAM_LIVE_DIR: directory,
        KINMESH_TEAM_MCP_ENDPOINT: endpoint,
        ...(inbox
          ? {
              KINMESH_TEAM_LIVE_SCENARIO: 'inbox',
              KINMESH_T3_ENVIRONMENT_ID: environment.environmentId,
              KINMESH_TEAM_T3_ISOLATED_PROVIDER: 'inbox-provider',
              KINMESH_T3_MODEL: 'gpt-6.1-sol',
            }
          : {}),
      },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  return LiveContext.parse(
    JSON.parse(readFileSync(join(directory, 'context.json'), 'utf8')),
  );
}
function fixture() {
  const temp = realpathSync(tmpdir());
  const sdk = mkdtempSync(join(temp, 'kinmesh-t3-live-fixture-'));
  const teamDir = join(temp, 'kinmesh-team-live-fixture-' + randomUUID());
  const inboxDir = join(temp, 'kinmesh-team-live-fixture-' + randomUUID());
  const team = prepare(teamDir, false, 'http://127.0.0.1:31001/mcp');
  const inbox = prepare(inboxDir, true, 'http://127.0.0.1:31002/mcp');
  // Deliberately not OAuth credentials: local configuration validation only stats these files.
  for (const directory of [sdk, teamDir, inboxDir])
    put(join(directory, 'oauth.json'), { fixture: 'not-authentication' });
  put(join(sdk, 'read-oauth.json'), { fixture: 'not-authentication' });
  const workerPath = join(inboxDir, 'inbox.json');
  const worker = {
    database: inbox.database,
    bindings: [
      {
        agentId: inbox.agentId,
        tokenFile: inbox.tokenFile,
        t3Endpoint: options.endpoint,
        t3AuthFile: join(inboxDir, 'oauth.json'),
        isolatedProviderId: 'inbox-provider',
        externalTeamMcpConfigured: true,
      },
    ],
  };
  put(workerPath, worker);
  const config = ReleaseConfig.parse({
    sdk: {
      directory: sdk,
      endpoint: options.endpoint,
      authFile: join(sdk, 'oauth.json'),
      readAuthFile: join(sdk, 'read-oauth.json'),
      providerId: 'codex',
      modelId: 'gpt-6.1-sol',
    },
    team: {
      directory: teamDir,
      endpoint: options.endpoint,
      authFile: join(teamDir, 'oauth.json'),
      providerId: 'team-provider',
      modelId: 'gpt-6.1-sol',
      externalTeamMcpConfigured: true,
    },
    inbox: { directory: inboxDir, configFile: workerPath },
  });
  const path = join(sdk, 'release.json');
  put(path, config);
  return {
    sdk,
    teamDir,
    inboxDir,
    team,
    inbox,
    config,
    path,
    worker,
    workerPath,
    plan: () => loadReleasePlan(path),
    dispose: () => {
      for (const dir of [sdk, teamDir, inboxDir])
        rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

await test('aggregate executes all preflights before isolated credential-free stage processes; Team consumes v1→v3 and Inbox still sees v1', async () => {
  const f = fixture();
  try {
    const stages = f.plan();
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as unknown;
    const scripts = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(manifest).scripts;
    for (const stage of stages)
      assert.equal(
        scripts[stage.command],
        'node --env-file-if-exists=.env --import tsx ' + stage.script,
      );
    assert.deepEqual(
      stages.map((s) => [s.command, s.script]),
      [
        ['test:live', 'scripts/t3-live.ts'],
        ['test:team-live', 'scripts/team-t3-live.ts'],
        ['test:inbox-live', 'scripts/inbox-t3-live.ts'],
      ],
    );
    const calls: string[] = [];
    await runRelease(
      stages,
      {
        preflight: (s) => {
          calls.push('preflight:' + s.name);
          return Promise.resolve();
        },
        run: async (s, env) => {
          calls.push('run:' + s.name);
          await runStage(
            { ...s, script: 'tests/fixtures/release-stage.ts' },
            { ...env, FIXTURE_STAGE: s.name },
          );
        },
      },
      {
        PATH: process.env.PATH,
        HOME: '/shared/provider',
        KINMESH_TEAM_LIVE_DIR: f.teamDir,
        KINMESH_SHARED_SECRET: 'fixture-secret',
        KINMESH_T3_PROVIDER_HOME: '/shared/provider',
        NODE_OPTIONS: '--invalid-inherited-option',
      },
    );
    assert.deepEqual(calls, [
      'preflight:sdk',
      'preflight:team',
      'preflight:inbox',
      'run:sdk',
      'run:team',
      'run:inbox',
    ]);
    for (const s of stages) {
      assert.equal(
        readFileSync(join(s.directory, 'fixture-stage-passed'), 'utf8'),
        s.name,
      );
      assert.ok(existsSync(join(s.directory, '.release-consumed')));
    }
    assert.throws(f.plan, /consumed/);
  } finally {
    f.dispose();
  }
});

await test('aggregate refuses missing opt-in, missing release config and the legacy single inherited directory', () => {
  const f = fixture();
  try {
    for (const env of [
      {},
      { KINMESH_RELEASE_CONFIG: f.path },
      { KINMESH_RELEASE_LIVE: '1' },
      {
        KINMESH_TEAM_LIVE_DIR: f.teamDir,
        KINMESH_TEAM_T3_LIVE: '1',
        KINMESH_INBOX_LIVE: '1',
      },
    ])
      assert.throws(() => releasePlanFromEnvironment(env));
    assert.equal(
      releasePlanFromEnvironment({
        KINMESH_RELEASE_CONFIG: f.path,
        KINMESH_RELEASE_LIVE: '1',
      }).length,
      3,
    );
  } finally {
    f.dispose();
  }
});

const invalid: [string, (f: Fixture) => void][] = [
  [
    'same consumed Team/Inbox directory',
    (f) => {
      f.config.inbox.directory = f.teamDir;
      put(f.path, f.config);
    },
  ],
  [
    'same Team MCP endpoint',
    (f) => {
      put(join(f.inboxDir, 'context.json'), {
        ...f.inbox,
        endpoint: f.team.endpoint,
      });
    },
  ],
  [
    'shared provider instance',
    (f) => {
      f.config.team.providerId = f.config.sdk.providerId;
      put(f.path, f.config);
    },
  ],
  [
    'shared OAuth path',
    (f) => {
      f.config.team.authFile = f.config.sdk.authFile;
      put(f.path, f.config);
    },
  ],
  [
    'public configuration',
    (f) => {
      chmodSync(f.path, 0o644);
    },
  ],
  [
    'symlinked database',
    (f) => {
      rmSync(f.inbox.database);
      symlinkSync(f.team.database, f.inbox.database);
    },
  ],
  [
    'hard-linked database',
    (f) => {
      rmSync(f.inbox.database);
      linkSync(f.team.database, f.inbox.database);
    },
  ],
  [
    'wrong Inbox database',
    (f) => {
      put(f.workerPath, { ...f.worker, database: f.team.database });
    },
  ],
  [
    'wrong Inbox token',
    (f) => {
      const binding = f.worker.bindings[0];
      assert.ok(binding);
      put(f.workerPath, {
        ...f.worker,
        bindings: [{ ...binding, tokenFile: f.team.tokenFile }],
      });
    },
  ],
  [
    'empty Inbox binding',
    (f) => {
      put(f.workerPath, { ...f.worker, bindings: [] });
    },
  ],
  [
    'missing explicit external MCP assertion',
    (f) => {
      const binding = f.worker.bindings[0];
      assert.ok(binding);
      put(f.workerPath, {
        ...f.worker,
        bindings: [{ ...binding, externalTeamMcpConfigured: false }],
      });
    },
  ],
  [
    'stale SDK output',
    (f) => {
      put(join(f.sdk, 'sdk-report.json'), {});
    },
  ],
  [
    'consumed task',
    (f) => {
      const s = openStore(f.inbox.database);
      try {
        const p = s.agents.resolveToken(loadAgentToken(f.inbox.tokenFile));
        s.tasks.command(p, f.inbox.teamId, f.inbox.channelId, f.inbox.taskId, {
          type: 'claim',
          operationKey: randomUUID(),
          expectedVersion: 1,
        });
      } finally {
        s.close();
      }
    },
  ],
  [
    'reviewer removed from channel',
    (f) => {
      const s = openStore(f.team.database);
      try {
        s.communication.enroll(
          { kind: 'human', humanId: f.team.humanId },
          f.team.teamId,
          f.team.channelId,
          {
            operationKey: randomUUID(),
            member: { kind: 'agent', id: f.team.reviewerId },
          },
          'remove',
        );
      } finally {
        s.close();
      }
    },
  ],
  [
    'nonfresh Inbox',
    (f) => {
      const s = openStore(f.inbox.database);
      try {
        s.communication.post(
          { kind: 'human', humanId: f.inbox.humanId },
          f.inbox.teamId,
          f.inbox.channelId,
          {
            operationKey: randomUUID(),
            body: 'fixture mention',
            mentions: [{ kind: 'agent', id: f.inbox.agentId }],
            topicId: null,
            sourceMessageId: null,
            sourceEventId: null,
          },
        );
      } finally {
        s.close();
      }
    },
  ],
  [
    'insufficient persisted scopes',
    (f) => {
      const s = openStore(f.inbox.database);
      try {
        const grant = s.agents.issue(
          { kind: 'human', humanId: f.inbox.humanId },
          f.inbox.teamId,
          f.inbox.agentId,
          {
            label: 'insufficient fixture',
            scopes: ['tasks:read'],
            lifetimeSeconds: 3600,
          },
        );
        put(f.inbox.tokenFile, { token: grant.token });
      } finally {
        s.close();
      }
    },
  ],
];
for (const [name, mutate] of invalid)
  await test('aggregate rejects before any native stage: ' + name, () => {
    const f = fixture();
    try {
      assert.equal(f.plan().length, 3);
      mutate(f);
      assert.throws(f.plan);
      for (const dir of [f.sdk, f.teamDir, f.inboxDir])
        assert.equal(existsSync(join(dir, '.release-consumed')), false);
    } finally {
      f.dispose();
    }
  });

for (const failure of ['sdk', 'team', 'inbox'])
  await test(
    'preflight ' + failure + ' failure starts zero native stage processes',
    async () => {
      const f = fixture();
      try {
        let runs = 0;
        await assert.rejects(
          runRelease(
            f.plan(),
            {
              preflight: (s) =>
                s.name === failure
                  ? Promise.reject(new Error('fixture readiness failure'))
                  : Promise.resolve(),
              run: () => {
                runs++;
                return Promise.resolve();
              },
            },
            {},
          ),
        );
        assert.equal(runs, 0);
        assert.equal(existsSync(join(f.teamDir, '.release-consumed')), false);
      } finally {
        f.dispose();
      }
    },
  );

await test('a native stage failure blocks all later stages and prevents fixture reuse', async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    await assert.rejects(
      runRelease(
        f.plan(),
        {
          preflight: () => Promise.resolve(),
          run: (s) => {
            calls.push(s.name);
            return Promise.reject(new Error('fixture native failure'));
          },
        },
        {},
      ),
    );
    assert.deepEqual(calls, ['sdk']);
    assert.throws(f.plan, /consumed/);
  } finally {
    f.dispose();
  }
});

const credential: Credential = {
  endpoint: options.endpoint,
  environmentId: environment.environmentId,
  client: { client_id: 'fixture-only' },
  tokens: {
    access_token: 'synthetic-not-a-grant',
    token_type: 'Bearer',
    scope: 'orchestration:read orchestration:operate',
  },
};
for (const variant of [
  'valid',
  'missing-operate',
  'unknown-provider',
  'unknown-model',
  'constrained',
  'unsupported-approval-mode',
  'wrong-environment',
])
  await test(
    'credential-free native preflight: ' + variant + ' never calls launch/send',
    async () => {
      const f = fixture();
      try {
        const stage = f.plan()[0];
        assert.ok(stage);
        const wire = new MockWire();
        const c = structuredClone(credential);
        if (variant === 'missing-operate')
          c.tokens.scope = 'orchestration:read';
        if (variant === 'unknown-provider') stage.providerId = 'absent';
        if (variant === 'unknown-model') stage.modelId = 'absent';
        if (variant === 'wrong-environment') c.environmentId = 'absent';
        if (
          variant === 'constrained' ||
          variant === 'unsupported-approval-mode'
        ) {
          const caps = Capabilities.parse(
            wire.values.orchestrator_capabilities,
          );
          const provider = caps.providers.find(
            (p) => p.providerInstanceId === stage.providerId,
          );
          assert.ok(provider);
          if (variant === 'constrained') provider.constraints = ['not-ready'];
          else provider.runtimeModes = ['full-access'];
          wire.values.orchestrator_capabilities = caps;
        }
        if (variant === 'valid') await probeNative(stage, c, wire);
        else await assert.rejects(probeNative(stage, c, wire));
        assert.ok(wire.calls.length > 0);
        assert.ok(
          wire.calls.every((call) =>
            ['t3_environment_read', 'orchestrator_capabilities'].includes(
              call.name,
            ),
          ),
        );
      } finally {
        f.dispose();
      }
    },
  );

await test('independent real local Team MCP read preflight passes both fresh contexts and rejects a wrong server before any provider', async () => {
  const f = fixture();
  const servers = [];
  try {
    const stages = f.plan().filter((s) => s.context);
    for (const stage of stages) {
      assert.ok(stage.context);
      const port = await freePort();
      servers.push(await startTeam(stage.context.database, port));
      stage.context.endpoint = `http://127.0.0.1:${String(port)}/mcp`;
      await probeTeam(stage);
    }
    const first = stages[0];
    const last = stages[1];
    assert.ok(first?.context);
    assert.ok(last?.context);
    last.context.endpoint = first.context.endpoint;
    await assert.rejects(probeTeam(last));
  } finally {
    for (const server of servers) await stop(server);
    f.dispose();
  }
});
