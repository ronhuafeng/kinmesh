import {
  lstatSync,
  realpathSync,
  readFileSync,
  accessSync,
  constants,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Endpoint } from '../src/adapters/t3/oauth.js';
import { LiveContext } from '../src/team-mcp/live-context.js';
import { loadWorkerConfig } from '../src/inbox/config.js';
import { loadAgentToken } from '../src/team-mcp/client.js';
import { openStore } from '../src/persistence/store.js';

const Path = z.string().min(1).refine(isAbsolute);
const Native = z.strictObject({
  directory: Path,
  endpoint: Endpoint,
  authFile: Path,
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});
export const ReleaseConfig = z.strictObject({
  sdk: Native.extend({ readAuthFile: Path }),
  team: Native.extend({ externalTeamMcpConfigured: z.literal(true) }),
  inbox: z.strictObject({ directory: Path, configFile: Path }),
});
export type ReleaseConfig = z.infer<typeof ReleaseConfig>;
export function privateFile(path: string, maxBytes = 65536) {
  const stat = lstatSync(path);
  if (
    !isAbsolute(path) ||
    realpathSync(path) !== path ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o177) !== 0 ||
    stat.size > maxBytes
  )
    throw new Error('Private canonical file required');
  accessSync(path, constants.R_OK | constants.W_OK);
}
function privateDirectory(path: string, prefix: string) {
  const stat = lstatSync(path);
  if (
    dirname(path) !== realpathSync(tmpdir()) ||
    realpathSync(path) !== path ||
    !basename(path).startsWith(prefix) ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Private canonical disposable directory required');
  accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  if (lstatSync(join(path, '.release-consumed'), { throwIfNoEntry: false }))
    throw new Error('Previously consumed release fixture');
}
function containedFile(directory: string, path: string, maxBytes = 65536) {
  if (dirname(path) !== directory)
    throw new Error('Stage-private file required');
  privateFile(path, maxBytes);
}
function contextAt(directory: string) {
  const path = join(directory, 'context.json');
  containedFile(directory, path);
  const context = LiveContext.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (
    context.database !== join(directory, 'team.sqlite') ||
    context.tokenFile !== join(directory, 'developer.json')
  )
    throw new Error('Wrong disposable context');
  containedFile(directory, context.database, Number.MAX_SAFE_INTEGER);
  containedFile(directory, context.tokenFile);
  return context;
}
export interface ReleaseStage {
  name: 'sdk' | 'team' | 'inbox';
  command: 'test:live' | 'test:team-live' | 'test:inbox-live';
  script: string;
  directory: string;
  endpoint: string;
  authFile: string;
  readAuthFile?: string;
  providerId: string;
  modelId: string;
  context?: z.infer<typeof LiveContext>;
  env: Record<string, string>;
}
export function releasePlanFromEnvironment(env: NodeJS.ProcessEnv) {
  if (env.KINMESH_RELEASE_LIVE !== '1' || !env.KINMESH_RELEASE_CONFIG)
    throw new Error(
      'Explicit aggregate opt-in and private release configuration required',
    );
  return loadReleasePlan(env.KINMESH_RELEASE_CONFIG);
}
export function loadReleasePlan(path: string): ReleaseStage[] {
  privateFile(path);
  const config = ReleaseConfig.parse(JSON.parse(readFileSync(path, 'utf8')));
  privateDirectory(config.sdk.directory, 'kinmesh-t3-live-');
  privateDirectory(config.team.directory, 'kinmesh-team-live-');
  privateDirectory(config.inbox.directory, 'kinmesh-team-live-');
  if (config.team.directory === config.inbox.directory)
    throw new Error('Separate Team and Inbox directories required');
  for (const c of [config.sdk, config.team])
    containedFile(c.directory, c.authFile);
  containedFile(config.sdk.directory, config.sdk.readAuthFile);
  if (config.sdk.authFile === config.sdk.readAuthFile)
    throw new Error('Separate read-only grant required');
  for (const name of ['sdk.sqlite', 'sdk-report.json'])
    if (lstatSync(join(config.sdk.directory, name), { throwIfNoEntry: false }))
      throw new Error('Fresh SDK outputs required');
  const team = contextAt(config.team.directory);
  const inbox = contextAt(config.inbox.directory);
  if (
    team.endpoint === inbox.endpoint ||
    team.teamId === inbox.teamId ||
    team.agentId === inbox.agentId ||
    team.taskId === inbox.taskId
  )
    throw new Error('Independent Team contexts required');
  containedFile(config.inbox.directory, config.inbox.configFile);
  const worker = loadWorkerConfig(config.inbox.configFile);
  const binding = worker.bindings[0];
  if (
    worker.database !== inbox.database ||
    worker.bindings.length !== 1 ||
    binding?.agentId !== inbox.agentId ||
    binding.tokenFile !== inbox.tokenFile
  )
    throw new Error('Single private Inbox binding required');
  containedFile(config.inbox.directory, binding.t3AuthFile);
  if (
    new Set([
      config.sdk.providerId,
      config.team.providerId,
      binding.isolatedProviderId,
    ]).size !== 3
  )
    throw new Error('Dedicated provider instance per stage required');
  // Validate both databases and grants before opening any native connection.
  validateFixture(team, false);
  validateFixture(inbox, true);
  const profileStore = openStore(inbox.database);
  let modelId: string;
  try {
    const principal = profileStore.agents.resolveToken(
      loadAgentToken(binding.tokenFile),
    );
    const profile = profileStore.agents.authorize(
      principal,
      inbox.teamId,
      inbox.agentId,
      'executions:write',
    );
    if (
      profile.preferences.providerId !== binding.isolatedProviderId ||
      !profile.preferences.modelId ||
      !profile.preferences.environmentId
    )
      throw new Error('Inbox native preferences required');
    modelId = profile.preferences.modelId;
  } finally {
    profileStore.close();
  }
  const common = (c: z.infer<typeof Native>) => ({
    KINMESH_T3_ENDPOINT: c.endpoint,
    KINMESH_T3_AUTH_FILE: c.authFile,
    KINMESH_T3_MODEL: c.modelId,
  });
  return [
    {
      name: 'sdk',
      command: 'test:live',
      script: 'scripts/t3-live.ts',
      ...config.sdk,
      env: {
        ...common(config.sdk),
        KINMESH_T3_LIVE: '1',
        KINMESH_T3_READ_AUTH_FILE: config.sdk.readAuthFile,
        KINMESH_T3_PROVIDER: config.sdk.providerId,
        KINMESH_T3_LIVE_DATABASE: join(config.sdk.directory, 'sdk.sqlite'),
        KINMESH_T3_LIVE_REPORT: join(config.sdk.directory, 'sdk-report.json'),
      },
    },
    {
      name: 'team',
      command: 'test:team-live',
      script: 'scripts/team-t3-live.ts',
      ...config.team,
      context: team,
      env: {
        ...common(config.team),
        KINMESH_TEAM_T3_LIVE: '1',
        KINMESH_TEAM_LIVE_DIR: config.team.directory,
        KINMESH_TEAM_T3_ISOLATED_PROVIDER: config.team.providerId,
      },
    },
    {
      name: 'inbox',
      command: 'test:inbox-live',
      script: 'scripts/inbox-t3-live.ts',
      directory: config.inbox.directory,
      endpoint: binding.t3Endpoint,
      authFile: binding.t3AuthFile,
      providerId: binding.isolatedProviderId,
      modelId,
      context: inbox,
      env: {
        KINMESH_INBOX_LIVE: '1',
        KINMESH_TEAM_LIVE_DIR: config.inbox.directory,
        KINMESH_INBOX_CONFIG: config.inbox.configFile,
      },
    },
  ];
}
export function validateFixture(
  context: z.infer<typeof LiveContext>,
  inbox: boolean,
) {
  privateFile(context.database, Number.MAX_SAFE_INTEGER);
  const store = openStore(context.database);
  try {
    const p = store.agents.resolveToken(loadAgentToken(context.tokenFile));
    if (
      p.kind !== 'agent' ||
      p.agentId !== context.agentId ||
      p.teamId !== context.teamId
    )
      throw new Error('Wrong Team grant');
    for (const scope of [
      'channels:read',
      'channels:write',
      'tasks:read',
      ...(inbox
        ? (['executions:write', 'executions:read'] as const)
        : (['tasks:write'] as const)),
    ] as const)
      store.agents.teamAccess(p, context.teamId, scope);
    const task = store.tasks.get(
      p,
      context.teamId,
      context.channelId,
      context.taskId,
    );
    if (
      task.state.status !== 'proposed' ||
      task.version !== 1 ||
      store.inbox.status().some((r) => r.count > 0)
    )
      throw new Error('Fresh task and Inbox required');
    store.communication.message(
      p,
      context.teamId,
      context.channelId,
      context.sourceMessageId,
    );
    for (const target of [
      { kind: 'agent', id: context.reviewerId },
      { kind: 'human', id: context.humanId },
    ] as const)
      store.communication.validateParticipant(
        p,
        context.teamId,
        context.channelId,
        target,
      );
    const reviewer = store.agents.get(
      { kind: 'human', humanId: context.humanId },
      context.teamId,
      context.reviewerId,
    );
    if (reviewer.lifecycle !== 'active')
      throw new Error('Active reviewer required');
  } finally {
    store.close();
  }
}
/** No inherited Kinmesh configuration, dotenv, NODE_OPTIONS or shared local Provider home. */
export function stageEnvironment(
  stage: ReleaseStage,
  inherited: NodeJS.ProcessEnv,
) {
  const env: NodeJS.ProcessEnv = { HOME: stage.directory, ...stage.env };
  for (const name of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SystemRoot',
  ])
    if (inherited[name] !== undefined) env[name] = inherited[name];
  return env;
}
