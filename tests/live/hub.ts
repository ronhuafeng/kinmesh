import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from '@playwright/test';
import { Agent, Grant } from '../../src/domain/agents.js';
import { Task } from '../../src/domain/tasks.js';
import { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { type Native, models, roles, type Role } from './native.js';
import { Process, port, ready } from './processes.js';

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
  async api(path: string, data?: unknown, method?: 'PUT') {
    const request = this.page?.request;
    if (!request) throw new Error('HUB_PAGE_REQUIRED');
    const response =
      method === 'PUT'
        ? await request.put(this.origin + path, { data })
        : data === undefined
          ? await request.get(this.origin + path)
          : await request.post(this.origin + path, { data });
    if (!response.ok())
      throw new Error('OWNER_API_' + String(response.status()));
    return response.status() === 204
      ? null
      : (response.json() as Promise<unknown>);
  }
  async start(inbox = false) {
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
      ...(inbox
        ? {
            KINMESH_INBOX_CONFIG: join(this.root, 'inbox.json'),
            KINMESH_T3_ENDPOINT: this.native.endpoint,
            KINMESH_T3_AUTH_FILE: join(this.root, 'read-only.json'),
          }
        : {}),
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
    await page.goto(this.origin);
    await page.getByRole('tab', { name: 'First owner setup' }).click();
    await page.getByLabel('Setup secret', { exact: true }).fill(this.setup);
    await page.getByLabel('Owner username', { exact: true }).fill('ci_owner');
    await page
      .getByLabel('Owner password', { exact: true })
      .fill(this.password);
    await page.getByLabel('Team name', { exact: true }).fill('CI Team');
    await page.getByRole('button', { name: 'Create owner and team' }).click();
    await page
      .getByText('Owner created. Sign in with your new credentials.')
      .waitFor();
    await page.getByLabel('Username', { exact: true }).fill('ci_owner');
    await page.getByLabel('Password', { exact: true }).fill(this.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page
      .getByRole('heading', { name: '# general', exact: true })
      .waitFor();
    await page.getByText('New channel', { exact: true }).click();
    const channel = page.getByRole('form', { name: 'Create a channel' });
    await channel.getByLabel('Channel name').fill('collaboration');
    await channel
      .getByRole('button', { name: 'Create channel', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Channels' })
      .getByRole('button', { name: 'collaboration', exact: true })
      .click();
    await page
      .getByRole('heading', { name: '# collaboration', exact: true })
      .waitFor();
    const me = z
      .object({ human: z.object({ id: z.string() }) })
      .parse(await this.api('/api/me'));
    this.humanId = me.human.id;
    for (const role of roles) {
      await page.getByRole('tab', { name: 'Agents & activity' }).click();
      const name = 'CI ' + role;
      const form = page.getByRole('form', { name: 'Agent profile' });
      if (!(await form.isVisible()))
        await page.getByText('Register agent', { exact: true }).first().click();
      await form.getByLabel('Agent name').fill(name);
      await form.getByLabel('Role', { exact: true }).selectOption(role);
      await form
        .getByRole('button', { name: 'Register agent', exact: true })
        .click();
      await page.getByRole('heading', { name, exact: true }).waitFor();
      await page
        .getByRole('button', { name: `Add ${name} to channel`, exact: true })
        .click();
    }
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
              'executions:read',
              'executions:write',
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
  async bind(environmentId: string) {
    const bindings = [];
    for (const role of roles) {
      const { profile, token } = this.agent(role);
      await this.api(
        `/api/teams/${this.teamId}/agents/${profile.id}`,
        {
          name: profile.name,
          role,
          capabilities: profile.capabilities,
          memoryLocation: null,
          preferences: {
            environmentId,
            providerId: this.native.provider(role),
            modelId: models[this.native.executor],
          },
        },
        'PUT',
      );
      const tokenFile = join(this.root, role + '.json');
      writeFileSync(tokenFile, JSON.stringify({ token }), { mode: 0o600 });
      bindings.push({
        agentId: profile.id,
        tokenFile,
        t3Endpoint: this.native.endpoint,
        t3AuthFile: join(this.root, 'supervised.json'),
        isolatedProviderId: this.native.provider(role),
        externalTeamMcpConfigured: true,
      });
    }
    writeFileSync(
      join(this.root, 'inbox.json'),
      JSON.stringify({ database: this.database, pollMs: 250, bindings }),
      { mode: 0o600 },
    );
  }
  async createTask() {
    const page = this.page;
    if (!page) throw new Error('NO_WORKSPACE');
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await page
      .locator('summary')
      .filter({ hasText: /^Create task$/ })
      .click();
    const form = page.getByRole('form', { name: 'New task' });
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url() ===
          `${this.origin}/api/teams/${this.teamId}/channels/${this.channelId}/tasks`
      )
        this.createdInput = request.postDataJSON() as unknown;
    });
    await form.getByLabel('Task title').fill(this.title);
    await form
      .getByLabel('Description', { exact: true })
      .fill(
        `Use only Team MCP; no shell or file operations. Discover tools through the MCP catalog and use its fully qualified kinmesh tool names. Do not inspect local configuration. Read the task, channel messages, and decision history through Team MCP before publishing. Compare Inbox agentId with the current owner/reviewer to identify your role. Developer: publish one artifact containing ${this.marker} and 7 x 8 = 56. Follow the latest Human rework note; version the artifact. Use team_messages_send with mentions [], topicId null, sourceMessageId null and sourceEventId from this Inbox event. Use stable operation keys derived from task ID and version. Read the task again, then team_task_handoff in mode review to the assigned reviewer with current expectedVersion and the actual artifact message reference. Reviewer: independently read actual channel artifacts and task history, check criteria and latest Human rework note, publish an evidence-based review, read current task, then team_task_review approve or rework with current expectedVersion. Never accept a task. Return a concise actual assistant response.`,
      );
    await form
      .getByLabel('Acceptance criteria (one per line)')
      .fill(
        `Artifact contains ${this.marker}\nArtifact states 7 x 8 = 56\nIndependent review; final acceptance belongs to Human`,
      );
    await form
      .getByLabel('Owner', { exact: true })
      .selectOption('agent:' + this.agent('developer').profile.id);
    await form
      .getByLabel('Reviewer', { exact: true })
      .selectOption('agent:' + this.agent('reviewer').profile.id);
    await form
      .getByRole('button', { name: 'Create task', exact: true })
      .click();
    await page
      .getByRole('article', { name: this.title, exact: true })
      .waitFor();
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
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    const card = page.getByRole('article', { name: this.title, exact: true });
    await card.getByLabel('Action', { exact: true }).selectOption(action);
    await card
      .getByLabel('Decision note')
      .fill(
        action === 'rework'
          ? this.reworkNote
          : 'Test Human accepts the actual verified second artifact after independent review.',
      );
    await card
      .getByRole('button', {
        name: action === 'rework' ? 'Request rework' : 'Accept task',
        exact: true,
      })
      .click();
  }
  async close() {
    let grantsRevoked = true;
    if (this.page && this.teamId)
      for (const { profile, grant, token } of this.agents.values())
        await this.api(
          `/api/teams/${this.teamId}/agents/${profile.id}/grants/${grant.id}/revoke`,
          {},
        )
          .then(async () => {
            const response = await fetch(this.teamOrigin + '/mcp', {
              method: 'POST',
              headers: { authorization: 'Bearer ' + token },
            });
            if (response.status !== 401) grantsRevoked = false;
          })
          .catch(() => {
            grantsRevoked = false;
          });
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
