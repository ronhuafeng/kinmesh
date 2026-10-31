import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { fixture } from './helpers.js';
import { CALLBACK } from '../src/adapters/t3/authorization.js';

async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Private terminal fixture deadline');
    await delay(20);
  }
}
await test(
  'AUTH MANUAL MOCK PTY: real CLI uses hidden paste with Ctrl+T disabled; official SDK alone exchanges PKCE',
  { timeout: 25000 },
  async () => {
    const f = fixture();
    let origin = '';
    let state = '';
    let challenge = '';
    let exchanges = 0;
    let validPkce = false;
    const code = 'fixture-hidden-code-must-not-echo';
    const server = createServer((request, response) => {
      const run = async () => {
        const path = new URL(request.url ?? '/', origin).pathname;
        response.setHeader('content-type', 'application/json');
        const reply = (data: unknown) => {
          response.end(JSON.stringify(data));
        };
        if (path.startsWith('/.well-known/oauth-protected-resource')) {
          reply({
            resource: origin + '/mcp',
            authorization_servers: [origin],
            scopes_supported: ['orchestration:read', 'orchestration:operate'],
          });
          return;
        }
        if (path === '/.well-known/oauth-authorization-server') {
          reply({
            issuer: origin,
            authorization_endpoint: origin + '/oauth/mcp/authorize',
            token_endpoint: origin + '/oauth/mcp/token',
            registration_endpoint: origin + '/oauth/mcp/register',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            authorization_response_iss_parameter_supported: true,
          });
          return;
        }
        if (path === '/.well-known/t3/environment') {
          reply({
            environmentId: 'fixture-env',
            serverVersion: '0.1.5',
          });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const value of request)
          chunks.push(
            Buffer.isBuffer(value) ? value : Buffer.from(String(value)),
          );
        const body = Buffer.concat(chunks).toString();
        if (path === '/oauth/mcp/register') {
          reply({
            ...z.record(z.string(), z.unknown()).parse(JSON.parse(body)),
            client_id: 'fixture-client',
          });
          return;
        }
        if (path === '/oauth/mcp/token') {
          exchanges++;
          const form = new URLSearchParams(body);
          validPkce =
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url') === challenge &&
            form.get('code') === code &&
            form.get('redirect_uri') === CALLBACK;
          reply({
            access_token: 'fake-unit-only-token',
            token_type: 'Bearer',
            scope: 'orchestration:read orchestration:operate',
          });
          return;
        }
        response.writeHead(404);
        reply({});
      };
      void run().catch(() => {
        response.writeHead(500).end('{}');
      });
    });
    let child: ChildProcess | undefined;
    let closed: Promise<unknown[]> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      origin = 'http://127.0.0.1:' + String(address.port);
      const output = join(f.directory, 'new-oauth.json');
      // BSD script needs a pipe, not Node's socket-backed stdin. cat supplies that pipe.
      // Both variants allocate a real terminal without a transcript file.
      child = spawn(
        process.platform === 'darwin' ? 'sh' : 'script',
        process.platform === 'darwin'
          ? [
              '-c',
              'cat | script -q /dev/null "$@"',
              'kinmesh-pty',
              process.execPath,
              '--import',
              'tsx',
              'scripts/t3-auth.ts',
            ]
          : [
              '--quiet',
              '--return',
              '--command',
              'node --import tsx scripts/t3-auth.ts',
              '/dev/null',
            ],
        {
          env: {
            PATH: process.env.PATH ?? '',
            TERM: 'xterm',
            KINMESH_T3_AUTH_MODE: 'manual',
            KINMESH_T3_ENDPOINT: origin + '/mcp',
            KINMESH_T3_AUTH_FILE: output,
          },
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      closed = once(child, 'close', { signal: AbortSignal.timeout(20000) });
      let transcript = '';
      child.stdout?.on('data', (buffer: Buffer) => {
        transcript = (transcript + buffer.toString()).slice(-32768);
      });
      child.stderr?.on('data', (buffer: Buffer) => {
        transcript = (transcript + buffer.toString()).slice(-32768);
      });
      await until(() =>
        transcript.includes('Paste the FINAL localhost redirect URL'),
      );
      const printed = transcript
        .split(/\r?\n/)
        .find((line) => line.startsWith(origin + '/oauth/mcp/authorize?'));
      assert.ok(
        printed,
        'one URL was presented in the private fixture terminal',
      );
      assert.ok(
        URL.canParse(printed.trim()),
        'fixture authorization URL must parse',
      );
      const url = new URL(printed.trim());
      state = url.searchParams.get('state') ?? '';
      challenge = url.searchParams.get('code_challenge') ?? '';
      const redirect =
        CALLBACK +
        '?' +
        new URLSearchParams({ state, code, iss: origin }).toString();
      child.stdin?.write('\x14' + redirect + '\r'); // Ctrl+T must never reveal pasted input.
      if (process.platform === 'darwin') child.stdin?.end();
      const result = await closed;
      assert.equal(result[0], 0);
      assert.equal(exchanges, 1);
      assert.equal(validPkce, true);
      assert.equal(
        transcript.includes(code),
        false,
        'hidden input must not echo',
      );
      assert.equal(
        transcript.includes(redirect),
        false,
        'callback URL must not appear in terminal output',
      );
      assert.equal(transcript.includes('fake-unit-only-token'), false);
      assert.equal(transcript.includes('T3_AUTH PASS:'), true);
      assert.equal(existsSync(output), true);
      assert.equal(statSync(output).mode & 0o777, 0o600);
      const saved = z
        .object({ endpoint: z.string(), environmentId: z.string() })
        .parse(JSON.parse(readFileSync(output, 'utf8')));
      assert.ok(
        saved.endpoint === origin + '/mcp' &&
          saved.environmentId === 'fixture-env',
      );
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Fixture exited. */
        }
      }
      if (closed)
        await closed.catch(() => {
          /* Original test reports a fixed deadline only. */
        });
      server.closeAllConnections();
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
      f.cleanup();
    }
  },
);
