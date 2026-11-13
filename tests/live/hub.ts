import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadAgentToken } from '../../src/team-mcp/client.js';
import { expect, type Page } from '@playwright/test';
import { loadCredential } from '../../src/adapters/t3/oauth.js';
import {
  t3AuthFile,
  managedDirectory,
  agentTokenFile,
} from '../../src/inbox/managed.js';
import { Agent, Grant } from '../../src/domain/agents.js';
import { Task } from '../../src/domain/tasks.js';
import { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { type Native, models, roles, type Role } from './native.js';
import { Process, port, ready } from './processes.js';
import {
  createChannel,
  newTask,
  onboard,
  openAgent,
  openTask,
  refreshNow,
  register,
  untilReady,
} from '../browser/ui.js';

export class Hub {
  readonly database: string;
  readonly setup = randomBytes(32).toString('hex');
  readonly password = randomBytes(24).toString('base64url');
  readonly session = randomBytes(32).toString('hex');
  origin = '';
  teamOrigin = '';
  page: Page | undefined;
  process: Process | undefined;
  team: Process | undefined;
  teamId = '';
  channelId = '';
  humanId = '';
  taskId = '';
  createdInput: unknown;
  readonly title = 'CI collaboration ' + randomBytes(8).toString('hex');
  readonly marker = randomBytes(12).toString('hex');
  readonly reworkNote =
    'Produce a second version. Keep the marker and arithmetic, add verified, and obtain independent review again.';
  readonly agents = new Map<
    Role,
    {
      profile: z.infer<typeof Agent>;
      grant: z.infer<typeof Grant>;
      token: string;
    }
  >();
  constructor(
    readonly root: string,
    readonly native: Native,
  ) {
    this.database = join(root, 'team.sqlite');
  }
  async api(path: string, data?: unknown) {
    const request = this.page?.request;
    if (!request) throw new Error('HUB_PAGE_REQUIRED');
    const response =
      data === undefined
        ? await request.get(this.origin + path)
        : await request.post(this.origin + path, { data });
    if (!response.ok())
      throw new Error('OWNER_API_' + String(response.status()));
    return response.status() === 204
      ? null
      : (response.json() as Promise<unknown>);
  }
  async start() {
    if (!this.origin) this.origin = `http://127.0.0.1:${String(await port())}`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.root,
      NODE_ENV: 'test',
      KINMESH_DATABASE: this.database,
      KINMESH_SETUP_TOKEN: this.setup,
      KINMESH_SESSION_KEY: this.session,
      KINMESH_ORIGIN: this.origin,
      KINMESH_PORT: new URL(this.origin).port,
    };
    this.process = new Process(
      'npm',
      ['start'],
      env,
      join(this.root, 'hub.log'),
    );
    this.process.start();
    await ready(this.origin + '/health');
  }
  async onboard() {
    const context = this.native.context;
    if (!context) throw new Error('BROWSER_REQUIRED');
    this.page = await context.newPage();
    const page = this.page;
    page.setDefaultTimeout(15_000);
    await onboard(page, this, {
      username: 'ci_owner',
      password: this.password,
      team: 'CI Team',
    });
    await createChannel(page, 'collaboration');
    const me = z
      .object({ human: z.object({ id: z.string() }) })
      .parse(await this.api('/api/me'));
    this.humanId = me.human.id;
    // Registered from #collaboration, each agent joins it.
    for (const role of roles) await register(page, 'CI ' + role, role);
    const snapshot = WorkspaceSnapshot.parse(
      await this.api(
        '/api/workspace?channelId=' +
          (new URL(page.url()).searchParams.get('channel') ?? ''),
      ),
    );
    this.teamId = snapshot.team.id;
    const channels = z
      .object({
        channels: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .parse(await this.api('/api/team')).channels;
    this.channelId = channels.find((c) => c.name === 'collaboration')?.id ?? '';
    if (!this.channelId) throw new Error('CHANNEL_NOT_CREATED');
    const profiles = z
      .array(Agent)
      .parse(await this.api(`/api/teams/${this.teamId}/agents`));
    for (const role of roles) {
      const profile = profiles.find((a) => a.name === 'CI ' + role);
      if (!profile) throw new Error('PROFILE_NOT_CREATED');
      const issued = z.object({ token: z.string(), grant: Grant }).parse(
        await this.api(
          `/api/teams/${this.teamId}/agents/${profile.id}/grants`,
          {
            label: 'CI only',
            scopes: [
              'channels:read',
              'channels:write',
              'tasks:read',
              'tasks:write',
              ...(role === 'reviewer' ? ['tasks:review'] : []),
            ],
            lifetimeSeconds: 3600,
          },
        ),
      );
      this.agents.set(role, { profile, ...issued });
      const client = new Client({
        name: 'kinmesh-live-preflight',
        version: '1',
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(this.teamOrigin + '/mcp'), {
            requestInit: {
              headers: { authorization: 'Bearer ' + issued.token },
            },
          }),
        );
        const catalog = await client.listTools();
        this.native.configure(
          role,
          this.teamOrigin + '/mcp',
          issued.token,
          catalog.tools.map((tool) => tool.name),
        );
      } finally {
        await client.close();
      }
    }
  }
  agent(role: Role) {
    const agent = this.agents.get(role);
    if (!agent) throw new Error('AGENT_NOT_PREPARED');
    return agent;
  }
  async startTeam() {
    this.teamOrigin = `http://127.0.0.1:${String(await port())}`;
    this.team = new Process(
      process.execPath,
      ['--import', 'tsx', 'src/team-mcp/main.ts'],
      {
        PATH: process.env.PATH,
        HOME: this.root,
        KINMESH_DATABASE: this.database,
        KINMESH_TEAM_MCP_PORT: new URL(this.teamOrigin).port,
      },
      join(this.root, 'team.log'),
    );
    this.team.start();
    // Unauthenticated MCP access must be denied, proving the listener is the protected service.
    for (let i = 0; i < 100; i++) {
      try {
        if (
          (await fetch(this.teamOrigin + '/mcp', { method: 'POST' })).status ===
          401
        )
          return;
      } catch {
        /* startup */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('TEAM_MCP_NOT_READY');
  }
  workerPid() {
    const parent = this.process?.child;
    assert.ok(
      parent?.pid && parent.exitCode === null && parent.signalCode === null,
    );
    const entries = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], {
      encoding: 'utf8',
    })
      .split('\n')
      .flatMap((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
        return match
          ? [
              {
                pid: Number(match[1]),
                parent: Number(match[2]),
                command: match[3] ?? '',
              },
            ]
          : [];
      });
    const owned = new Set([parent.pid]);
    for (let depth = 0; depth < 8; depth++)
      for (const entry of entries)
        if (owned.has(entry.parent)) owned.add(entry.pid);
    const worker = entries.find(
      (entry) =>
        owned.has(entry.pid) && entry.command.includes('src/inbox/main.ts'),
    );
    assert.ok(worker, 'OWNED_WORKER_REQUIRED');
    return worker.pid;
  }
  async refresh() {
    if (!this.page) throw new Error('NO_WORKSPACE');
    await refreshNow(this.page);
  }
  /** The agent's page; its Setup region holds the next step. */
  async openAgent(role: Role) {
    const page = this.page;
    if (!page) throw new Error('NO_WORKSPACE');
    return openAgent(page, 'CI ' + role);
  }
  async connectT3(reconnect = false) {
    this.native.assertOwnedServer();
    const page = this.page;
    if (!page) throw new Error('NO_WORKSPACE');
    const setup = (await this.openAgent('developer')).getByRole('region', {
      name: 'Setup',
      exact: true,
    });
    if (reconnect)
      await setup
        .getByRole('button', { name: 'Reconnect', exact: true })
        .click();
    const connect = setup.getByRole('group', {
      name: 'Connect T3',
      exact: true,
    });
    await expect(
      connect.getByRole('button', { name: 'Connect T3', exact: true }),
    ).toBeEnabled();
    const another = connect.getByRole('button', {
      name: 'Use another T3',
      exact: true,
    });
    if (await another.isVisible()) await another.click();
    await connect.getByLabel('T3 MCP URL').fill(this.native.endpoint);
    await connect
      .getByRole('button', { name: 'Connect T3', exact: true })
      .click();
    const popupPromise = page.waitForEvent('popup');
    await connect.getByRole('link', { name: 'Approve in T3 ↗' }).click();
    const popup = await popupPromise;
    try {
      await popup.waitForURL((url) => url.origin === this.native.origin);
      await this.native.consent(popup, false);
      await popup
        .getByText('Authorization received. Return to your terminal.', {
          exact: true,
        })
        .waitFor();
    } finally {
      await popup.close();
    }
    await expect(connect).toHaveCount(0, { timeout: 15000 });
    const credential = loadCredential(
      t3AuthFile(managedDirectory(this.database)),
      this.native.endpoint,
    );
    assert.ok(
      credential.tokens.scope?.split(' ').includes('orchestration:operate'),
    );
    return credential;
  }
  async bind(environmentId: string) {
    const credential = await this.connectT3();
    assert.equal(credential.environmentId, environmentId);
    for (const role of roles) {
      const agent = await this.openAgent(role);
      const form = agent.getByRole('form', {
        name: `Choose what CI ${role} runs on`,
      });
      const choice =
        this.native.provider(role) + '\n' + models[this.native.executor];
      await expect(
        form
          .getByLabel('Model')
          .locator('option')
          .filter({ hasText: models[this.native.executor] })
          .first(),
      ).toBeAttached();
      await form.getByLabel('Model', { exact: true }).selectOption(choice);
      await form
        .getByRole('button', { name: 'Connect CI ' + role, exact: true })
        .click();
      // A real managed worker can take a while to start and be seen.
      if (this.page) await untilReady(this.page, 60000);
    }
    await this.page?.reload();
    for (const role of roles) {
      // What it runs on is said once, in About.
      const about = (await this.openAgent(role)).getByRole('complementary', {
        name: 'About',
      });
      await expect(about).toContainText(this.native.provider(role));
      await expect(about).toContainText(models[this.native.executor]);
      const profile = Agent.parse(
        await this.api(
          `/api/teams/${this.teamId}/agents/${this.agent(role).profile.id}`,
        ),
      );
      assert.deepEqual(profile.preferences, {
        environmentId,
        providerId: this.native.provider(role),
        modelId: models[this.native.executor],
      });
    }
    assert.equal(existsSync(join(this.root, 'inbox.json')), false);
  }
  async createTask() {
    const page = this.page;
    if (!page) throw new Error('NO_WORKSPACE');
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url() ===
          `${this.origin}/api/teams/${this.teamId}/channels/${this.channelId}/tasks`
      )
        this.createdInput = request.postDataJSON() as unknown;
    });
    await newTask(page, {
      title: this.title,
      description: `Use only Team MCP; no shell or file operations. Discover tools through the MCP catalog and use its fully qualified kinmesh tool names. Do not inspect local configuration. Read the task, channel messages, and decision history through Team MCP before publishing. Compare Inbox agentId with the current owner/reviewer to identify your role. Developer: publish one artifact containing ${this.marker} and 7 x 8 = 56. Follow the latest Human rework note; version the artifact. Use team_messages_send with mentions [], topicId null, sourceMessageId null and sourceEventId from this Inbox event. Use stable operation keys derived from task ID and version. Read the task again, then team_task_handoff in mode review to the assigned reviewer with current expectedVersion and the actual artifact message reference. Reviewer: independently read actual channel artifacts and task history, check criteria and latest Human rework note, publish an evidence-based review, read current task, then team_task_review approve or rework with current expectedVersion. Never accept a task. Return a concise actual assistant response.`,
      criteria: [
        `Artifact contains ${this.marker}`,
        'Artifact states 7 x 8 = 56',
        'Independent review; final acceptance belongs to Human',
      ],
      owner: 'agent:' + this.agent('developer').profile.id,
      reviewer: 'agent:' + this.agent('reviewer').profile.id,
    });
    const tasks = z
      .object({ items: z.array(Task) })
      .parse(
        await this.api(
          `/api/teams/${this.teamId}/channels/${this.channelId}/tasks`,
        ),
      );
    this.taskId = tasks.items.find((t) => t.title === this.title)?.id ?? '';
    if (!this.taskId) throw new Error('TASK_NOT_CREATED');
  }
  async task() {
    return Task.parse(
      await this.api(
        `/api/teams/${this.teamId}/channels/${this.channelId}/tasks/${this.taskId}`,
      ),
    );
  }
  async decision(action: 'rework' | 'accept') {
    const page = this.page;
    if (!page) throw new Error('NO_WORKSPACE');
    await this.refresh();
    const task = await openTask(page, this.title);
    await task
      .getByLabel('Decision note')
      .fill(
        action === 'rework'
          ? this.reworkNote
          : 'Test Human accepts the actual verified second artifact after independent review.',
      );
    await task
      .getByRole('button', {
        name: action === 'rework' ? 'Request rework' : 'Accept task',
        exact: true,
      })
      .click();
  }
  async close() {
    let grantsRevoked = true;
    if (this.page && this.teamId) {
      for (const { profile, token } of this.agents.values()) {
        try {
          const directory = managedDirectory(this.database);
          const managed = agentTokenFile(directory, profile.id);
          const tokens = [
            token,
            ...(existsSync(managed) ? [loadAgentToken(managed)] : []),
          ];
          const grants = z
            .array(Grant.omit({ agentId: true, teamId: true }))
            .parse(
              await this.api(
                `/api/teams/${this.teamId}/agents/${profile.id}/grants`,
              ),
            );
          for (const grant of grants.filter((g) => g.revokedAt === null))
            await this.api(
              `/api/teams/${this.teamId}/agents/${profile.id}/grants/${grant.id}/revoke`,
              {},
            );
          for (const bearer of tokens) {
            const response = await fetch(this.teamOrigin + '/mcp', {
              method: 'POST',
              headers: { authorization: 'Bearer ' + bearer },
            });
            if (response.status !== 401) grantsRevoked = false;
          }
        } catch {
          grantsRevoked = false;
        }
      }
    }
    const stopped = await Promise.allSettled([
      this.process?.stop(),
      this.team?.stop(),
    ]);
    return {
      grantsRevoked,
      servicesStopped: stopped.every((result) => result.status === 'fulfilled'),
    };
  }
}
