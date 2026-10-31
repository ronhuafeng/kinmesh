import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { z } from 'zod';
import type { Credential } from '../src/adapters/t3/oauth.js';
import { authority, loadCredential } from '../src/adapters/t3/oauth.js';
import { SdkWire } from '../src/adapters/t3/sdk.js';
import { T3Backend } from '../src/adapters/t3/backend.js';
import {
  Descriptor,
  ValidatedTools,
  type Wire,
} from '../src/adapters/t3/contracts.js';
import { openStore } from '../src/persistence/store.js';
import { connectAgent, loadAgentToken } from '../src/team-mcp/client.js';
import { Task } from '../src/domain/tasks.js';
import { Message } from '../src/domain/communication.js';
import { outcome } from '../src/team-mcp/tools.js';
import {
  stageEnvironment,
  validateFixture,
  type ReleaseStage,
} from './release-live-config.js';

/** Discovery, environment and capability reads only; never prepares or dispatches a native mutation. */
export async function probeNative(
  stage: ReleaseStage,
  credential: Credential,
  wire: Wire,
) {
  const store = openStore(
    stage.context?.database ?? stage.env.KINMESH_T3_LIVE_DATABASE ?? '',
  );
  try {
    if (stage.name === 'inbox' && stage.context) {
      const p = store.agents.resolveToken(
        loadAgentToken(stage.context.tokenFile),
      );
      const profile = store.agents.authorize(
        p,
        stage.context.teamId,
        stage.context.agentId,
        'executions:write',
      );
      if (profile.preferences.environmentId !== credential.environmentId)
        throw new Error('Inbox environment mismatch');
    }
    const backend = await T3Backend.connect(wire, store.operations, {
      endpoint: credential.endpoint,
      expectedEnvironmentId: credential.environmentId,
      authority: authority(credential),
      scopes: credential.tokens.scope?.split(/\s+/) ?? [],
    });
    backend.validateLaunch({
      target: { kind: 'scratch' },
      title: 'Release preflight; no launch',
      model: { providerId: stage.providerId, modelId: stage.modelId },
      mode: 'approval-required',
    });
  } finally {
    store.close();
    await wire.close();
  }
}
export async function probeTeam(stage: ReleaseStage) {
  if (!stage.context) return;
  const c = stage.context;
  validateFixture(c, stage.name === 'inbox');
  const client = await connectAgent(c.endpoint, c.tokenFile);
  try {
    const task = outcome(Task).parse(
      (
        await client.callTool({
          name: 'team_task_get',
          arguments: { channelId: c.channelId, taskId: c.taskId },
        })
      ).structuredContent,
    ).result;
    const message = outcome(Message).parse(
      (
        await client.callTool({
          name: 'team_message_get',
          arguments: { channelId: c.channelId, messageId: c.sourceMessageId },
        })
      ).structuredContent,
    ).result;
    if (
      !task.ok ||
      task.data.version !== 1 ||
      task.data.state.status !== 'proposed' ||
      !message.ok
    )
      throw new Error('Fresh authenticated Team read proof required');
  } finally {
    await client.close();
  }
}
export async function preflightStage(stage: ReleaseStage) {
  await probeTeam(stage);
  const credential = loadCredential(stage.authFile, stage.endpoint);
  await probeNative(stage, credential, new SdkWire(credential));
  if (stage.name === 'sdk' && stage.readAuthFile) {
    const readonly = loadCredential(stage.readAuthFile, stage.endpoint);
    if (
      readonly.tokens.scope !== 'orchestration:read' ||
      readonly.environmentId !== credential.environmentId
    )
      throw new Error('Same-environment Read only OAuth required');
    const wire = new SdkWire(readonly);
    try {
      const tools = new ValidatedTools(wire, await wire.list(), [
        't3_environment_read',
      ]);
      const descriptor = Descriptor.parse(
        await tools.call('t3_environment_read', {}),
      );
      if (descriptor.environmentId !== readonly.environmentId)
        throw new Error('Read only environment mismatch');
    } finally {
      await wire.close();
    }
  }
}
export async function runStage(stage: ReleaseStage, env: NodeJS.ProcessEnv) {
  // Deliberately omit --env-file; each stage gets only its validated private binding.
  const child = spawn(process.execPath, ['--import', 'tsx', stage.script], {
    env,
    stdio: 'inherit',
  });
  const result: unknown = await once(child, 'exit');
  const [code] = z
    .tuple([z.number().nullable(), z.string().nullable()])
    .parse(result);
  if (code !== 0) throw new Error('Native stage failed');
}
export async function runRelease(
  stages: ReleaseStage[],
  dependencies: { preflight: typeof preflightStage; run: typeof runStage },
  inherited: NodeJS.ProcessEnv,
) {
  // Every stage, including the final Inbox gate, must pass before the first model-capable child exists.
  for (const stage of stages) await dependencies.preflight(stage);
  // One-shot reservation: failures/uncertainty must never silently reuse a consumed fixture.
  for (const stage of stages)
    writeFileSync(
      join(stage.directory, '.release-consumed'),
      'Reserved by native release gate\n',
      { mode: 0o600, flag: 'wx' },
    );
  for (const stage of stages) {
    if (stage.context) validateFixture(stage.context, stage.name === 'inbox');
    await dependencies.run(stage, stageEnvironment(stage, inherited));
  }
}
