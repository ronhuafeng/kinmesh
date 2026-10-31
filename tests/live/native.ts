import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  authorize,
  callbackReceiver,
} from '../../src/adapters/t3/authorization.js';
import { saveCredential } from '../../src/adapters/t3/oauth.js';
import { Process, port, ready, until } from './processes.js';

export const Executor = z.enum(['codex', 'grok']);
export type Executor = z.infer<typeof Executor>;
export const models = { codex: 'gpt-6.1-sol', grok: 'grok-4.7' } as const;
export const roles = ['developer', 'reviewer'] as const;
export type Role = (typeof roles)[number];

export class Native {
  origin = '';
  endpoint = '';
  browser: Browser | undefined;
  context: BrowserContext | undefined;
  page: Page | undefined;
  server: Process | undefined;
  stage = 'native-start';
  cleanupErrors: string[] = [];
  readonly binary = process.env.KINMESH_T3_BINARY ?? 't3';
  constructor(
    readonly root: string,
    readonly executor: Executor,
  ) {}
  home(role: Role) {
    return join(this.root, role);
  }
  provider(role: Role) {
    return `ci_${role}`;
  }
  configure(
    role: Role,
    endpoint: string,
    token: string,
    availableTools: string[],
  ) {
    const home = this.home(role);
    const directory = join(
      home,
      this.executor === 'codex' ? '.codex' : '.grok',
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = process.env.LLM_API_KEY;
    const base =
      process.env[
        this.executor === 'codex' ? 'CODEX_BASE_URL' : 'GROK_BASE_URL'
      ];
    if (!key || !base || new URL(base).protocol !== 'https:')
      throw new Error('MODEL_CONFIGURATION_REQUIRED');
    const q = JSON.stringify;
    const config =
      this.executor === 'codex'
        ? `model = ${q(models.codex)}\nmodel_reasoning_effort = "low"\nmodel_provider = "ci"\n[model_providers.ci]\nname = "CI"\nbase_url = ${q(base)}\nwire_api = "responses"\nenv_key = "LLM_API_KEY"\n`
        : `[models]\ndefault = ${q(models.grok)}\n[model.${q(models.grok)}]\nmodel = ${q(models.grok)}\nbase_url = ${q(base)}\napi_backend = "responses"\nenv_key = "LLM_API_KEY"\n[permission]\ndeny = ["Bash(*)", "Read(**)", "Edit(**)", "Grep(**)", "WebFetch(*)", "WebSearch(*)"]\nallow = ["MCPTool(kinmesh__team_message_get)", "MCPTool(kinmesh__team_messages_read)", "MCPTool(kinmesh__team_task_get)", "MCPTool(kinmesh__team_tasks_history)"]\n`;
    const tools = [
      'team_message_get',
      'team_messages_read',
      'team_task_get',
      'team_tasks_history',
      'team_messages_send',
      role === 'developer' ? 'team_task_handoff' : 'team_task_review',
    ];
    if (!tools.every((name) => availableTools.includes(name)))
      throw new Error('TEAM_MCP_CATALOG_INCOMPLETE');
    const mcp =
      this.executor === 'codex'
        ? `enabled_tools = ${q(tools)}\nhttp_headers = { Authorization = ${q('Bearer ' + token)} }`
        : `headers = { Authorization = ${q('Bearer ' + token)} }\n[disabled_mcp_tools]\nkinmesh = ${q(availableTools.filter((name) => !tools.includes(name)))}`;
    writeFileSync(
      join(directory, 'config.toml'),
      config + `\n[mcp_servers.kinmesh]\nurl = ${q(endpoint)}\n${mcp}\n`,
      { mode: 0o600 },
    );
  }
  async start() {
    if (
      execFileSync(this.binary, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() !== 't3 v0.1.5'
    )
      throw new Error('T3_VERSION_MISMATCH');
    const providerBinary =
      process.env[
        this.executor === 'codex'
          ? 'KINMESH_CODEX_BINARY'
          : 'KINMESH_GROK_BINARY'
      ];
    if (!providerBinary) throw new Error('NATIVE_BINARY_REQUIRED');
    const version = execFileSync(providerBinary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (
      !(this.executor === 'codex'
        ? version === 'codex-cli 0.166.0'
        : /^grok 1\.0\.70(?: |$)/.test(version))
    )
      throw new Error('PROVIDER_VERSION_MISMATCH');
    this.origin = `http://127.0.0.1:${String(await port())}`;
    this.endpoint = this.origin + '/mcp';
    const home = join(this.root, 't3-home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const env = {
      HOME: home,
      GROK_HOME: join(home, '.grok'),
      CODEX_HOME: join(home, '.codex'),
      PATH: process.env.PATH,
      LLM_API_KEY: process.env.LLM_API_KEY,
    };
    this.server = new Process(
      this.binary,
      [
        'serve',
        '--mode',
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        new URL(this.origin).port,
        '--base-dir',
        join(this.root, 't3-state'),
        '--no-browser',
        this.root,
      ],
      env,
      join(this.root, 't3.log'),
    );
    this.server.start();
    await ready(this.origin + '/.well-known/t3/environment');
    this.browser = await chromium.launch();
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(10_000);
    this.stage = 'native-admin-pairing';
    const pairing = z
      .object({ pairUrl: z.string() })
      .parse(
        JSON.parse(
          execFileSync(
            this.binary,
            [
              'auth',
              'pairing',
              'create',
              '--base-dir',
              join(this.root, 't3-state'),
              '--base-url',
              this.origin,
              '--ttl',
              '30m',
              '--json',
            ],
            { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          ),
        ),
      );
    await this.page.goto(pairing.pairUrl);
    await this.page.getByText('Set up T3 Code', { exact: true }).waitFor();
    await this.page.getByRole('button', { name: 'Close', exact: true }).click();
    await this.page
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await this.page.getByText('Providers', { exact: true }).click();
  }
  async addProviders() {
    const page = this.page;
    if (!page) throw new Error('NO_NATIVE_PAGE');
    for (const role of roles) {
      this.stage = 'native-provider-' + role;
      await page
        .getByRole('button', { name: 'Add provider', exact: true })
        .first()
        .click();
      const dialog = page.getByRole('dialog', {
        name: 'Add provider',
        exact: true,
      });
      if (this.executor === 'grok')
        await dialog.getByText('Grok', { exact: true }).click();
      const manual = dialog.getByRole('button', {
        name: 'Configure manually',
        exact: true,
      });
      if (await manual.count()) await manual.click();
      else
        await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      await dialog.getByLabel('Label', { exact: true }).fill('CI ' + role);
      await dialog
        .getByLabel('Instance ID', { exact: true })
        .fill(this.provider(role));
      await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      const binary =
        process.env[
          this.executor === 'codex'
            ? 'KINMESH_CODEX_BINARY'
            : 'KINMESH_GROK_BINARY'
        ];
      if (!binary) throw new Error('NATIVE_BINARY_REQUIRED');
      await dialog.getByLabel('Binary path', { exact: true }).fill(binary);
      if (this.executor === 'codex')
        await dialog
          .getByLabel('CODEX_HOME path', { exact: true })
          .fill(join(this.home(role), '.codex'));
      await dialog
        .getByRole('button', { name: 'Add instance', exact: true })
        .click();
      await dialog.waitFor({ state: 'hidden' });
      // Explicit selection and a fresh UI read prove the role's persisted configuration.
      if (this.executor === 'grok') {
        await page
          .getByRole('button', { name: 'Select CI ' + role, exact: true })
          .click();
        for (const [index, [name, value]] of [
          ['HOME', this.home(role)],
          ['GROK_HOME', join(this.home(role), '.grok')],
          ['GROK_MAX_MCP_OUTPUT_BYTES', '131072'],
        ].entries()) {
          await page
            .getByRole('button', { name: 'Add variable', exact: true })
            .click();
          const field = page.getByLabel(
            'Environment variable name ' + String(index + 1),
            { exact: true },
          );
          await field.fill(name ?? '');
          await field.press('Enter');
          const sensitive = page.getByRole('button', {
            name: `Mark environment variable ${name ?? ''} as sensitive`,
            exact: true,
          });
          if ((await sensitive.getAttribute('aria-pressed')) === 'true')
            await sensitive.click();
          const input = page.getByLabel(
            'Environment variable value ' + String(index + 1),
            { exact: true },
          );
          await input.fill(value ?? '');
          await input.press('Enter');
          await page
            .getByRole('button', { name: 'Select CI ' + role, exact: true })
            .click();
        }
        await page.reload();
        await page.getByText('Providers', { exact: true }).first().click();
        await page
          .getByRole('button', { name: 'Select CI ' + role, exact: true })
          .click();
        const homeInput = page.getByLabel('Environment variable value 1', {
          exact: true,
        });
        const grokInput = page.getByLabel('Environment variable value 2', {
          exact: true,
        });
        const outputLimitInput = page.getByLabel(
          'Environment variable value 3',
          {
            exact: true,
          },
        );
        await until(
          async () =>
            (await outputLimitInput.inputValue()) === '131072' &&
            (await homeInput.inputValue()) === this.home(role) &&
            (await grokInput.inputValue()) === join(this.home(role), '.grok'),
          'PROVIDER_HOME_NOT_PERSISTED',
          10_000,
        );
      }
    }
  }
  async oauth(readOnly: boolean) {
    const page = this.page;
    if (!page) throw new Error('NO_NATIVE_PAGE');
    this.stage = readOnly ? 'native-oauth-read' : 'native-oauth-supervised';
    const signal = AbortSignal.timeout(60_000);
    let receiver: ReturnType<typeof callbackReceiver> | undefined;
    try {
      const credential = await authorize(
        this.endpoint,
        {
          async prepare(state, issuer, signal) {
            receiver = callbackReceiver(state, issuer, signal);
            receiver.server.listen(49871, '127.0.0.1');
            await once(receiver.server, 'listening');
            return { code: receiver.code };
          },
          async redirect(url) {
            await page.goto(url.href);
            await page
              .getByText(readOnly ? 'Read only' : 'Supervised', { exact: true })
              .click();
            await page
              .getByRole('button', { name: /authorize|allow|approve/i })
              .click();
          },
        },
        signal,
      );
      const file = join(
        this.root,
        readOnly ? 'read-only.json' : 'supervised.json',
      );
      saveCredential(file, credential, { replace: false });
      return credential;
    } finally {
      receiver?.server.closeAllConnections();
      receiver?.server.close();
    }
  }
  async close() {
    const stopped = await Promise.allSettled([
      this.browser?.close(),
      this.server?.stop(),
    ]);
    this.cleanupErrors = stopped.flatMap((result) =>
      result.status === 'rejected'
        ? [
            result.reason instanceof Error &&
            /^[A-Z_]+$/.test(result.reason.message)
              ? result.reason.message
              : 'CLEANUP_OPERATION_FAILED',
          ]
        : [],
    );
    if (stopped.some((result) => result.status === 'rejected'))
      throw new Error('NATIVE_CLEANUP_FAILED');
  }
}
