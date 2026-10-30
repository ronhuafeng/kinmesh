import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import {
  writeFileSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  authorize,
  authorizationFetch,
  callbackCode,
  callbackReceiver,
  CALLBACK,
} from '../src/adapters/t3/authorization.js';
import {
  Credential,
  credentialDestination,
  saveCredential,
} from '../src/adapters/t3/oauth.js';
import { fixture } from './helpers.js';
import { readSmoke } from '../src/adapters/t3/smoke.js';
import { MockWire, environment, captured } from './t3-helpers.js';

const state = 'fixture-state';
const issuer = 'https://t3.invalid';
const callback = (changes: Record<string, string> = {}) =>
  CALLBACK +
  '?' +
  new URLSearchParams({
    state,
    code: 'fixture-code',
    iss: issuer,
    ...changes,
  }).toString();
const redacted = (error: unknown) =>
  error instanceof Error && error.message === 'Authorization input rejected';
await test('AUTH CALLBACK: exact valid callback and opaque code; malformed/untrusted/ambiguous input is always redacted', () => {
  assert.ok(callbackCode(callback(), state, issuer) === 'fixture-code');
  const invalid = [
    callback().replace('127.0.0.1', 'localhost'),
    callback().replace('127.0.0.1', '127.1'),
    callback().replace('127.0.0.1', '[::1]'),
    callback().replace('127.0.0.1', '127.0.0.1.evil.test'),
    callback().replace(':49871', ':49872'),
    callback().replace('http:', 'https:'),
    callback().replace('/callback?', '/different?'),
    callback().replace('/callback?', '/a/../callback?'),
    callback().replace('127.0.0.1', 'user@127.0.0.1'),
    callback({ state: 'other' }),
    callback({ iss: 'https://other.invalid' }),
    callback({ iss: issuer + '/' }),
    callback({ code: '' }),
    callback({ code: 'white space' }),
    callback() + '&state=' + state,
    callback() + '&code=another',
    callback() + '&iss=' + issuer,
    callback() + '&%73tate=' + state,
    callback() + '&error=access_denied',
    callback() + '&redirect_uri=https://evil.invalid',
    callback() + '#',
    callback() + '&',
    callback().replace('?state=', '?&state='),
    callback() + '#fragment',
    callback() + '\n',
    callback().replace('callback?', 'callback\\?'),
    CALLBACK + '?state=' + state + '&iss=' + issuer + '&error=access_denied',
    callback({ code: '%GG' }),
    callback().replace('code=fixture-code', 'code=%FF'),
    'not-a-url',
    callback() + 'x'.repeat(8192),
  ];
  for (const value of invalid)
    assert.throws(() => callbackCode(value, state, issuer), redacted);
});

await test('AUTH LOCAL: real loopback receiver rejects hostile requests, accepts once, and preserves callback validation', async () => {
  const stop = new AbortController();
  const receiver = callbackReceiver(state, issuer, stop.signal);
  try {
    receiver.server.listen(0, '127.0.0.1');
    await once(receiver.server, 'listening');
    const address = receiver.server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    async function send(
      path: string,
      host = '127.0.0.1:49871',
      method = 'GET',
    ) {
      return await new Promise<number>((done, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: { host },
          },
          (response) => {
            response.resume();
            response.once('end', () => {
              done(response.statusCode ?? 0);
            });
          },
        );
        req.once('error', reject);
        req.end();
      });
    }
    const path = new URL(callback()).pathname + new URL(callback()).search;
    assert.equal(await send(path, 'evil.invalid'), 400);
    assert.equal(await send(path, '127.0.0.1:49871', 'POST'), 400);
    assert.equal(await send(path + '&code=duplicate'), 400);
    assert.equal(await send(path.replace('fixture-state', 'wrong')), 400);
    assert.equal(await send(path), 200);
    assert.ok((await receiver.code) === 'fixture-code');
    assert.equal(await send(path), 400);
  } finally {
    stop.abort();
    receiver.server.closeAllConnections();
    await new Promise<void>((done) => {
      receiver.server.close(() => {
        done();
      });
    });
  }
});
await test('AUTH LOCAL: deadline rejects pending callback without raw input', async () => {
  const stop = new AbortController();
  const receiver = callbackReceiver(state, issuer, stop.signal);
  stop.abort();
  await assert.rejects(receiver.code, redacted);
  receiver.server.close();
});

function oauthFixture(
  options: {
    expire?: boolean;
    wrongIssuer?: boolean;
    redirectRegistration?: boolean;
    abortExchange?: boolean;
  } = {},
) {
  const endpoint = issuer + '/mcp';
  let challenge = '';
  let callbackState = '';
  let exchanges = 0;
  let registrations = 0;
  let verifiedPkce = false;
  const stop = new AbortController();
  const reply = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const transport: FetchLike = async (input, init) => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return reply({
        resource: endpoint,
        authorization_servers: [issuer],
        scopes_supported: ['orchestration:read', 'orchestration:operate'],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return reply({
        issuer: options.wrongIssuer ? 'https://untrusted.invalid' : issuer,
        authorization_endpoint: issuer + '/oauth/mcp/authorize',
        token_endpoint: issuer + '/oauth/mcp/token',
        registration_endpoint: issuer + '/oauth/mcp/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === '/.well-known/t3/environment')
      return reply({ environmentId: 'fixture-env', serverVersion: '0.1.5' });
    if (url.pathname === '/oauth/mcp/register') {
      registrations++;
      if (options.redirectRegistration)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://untrusted.invalid/collect' },
        });
      return reply({
        ...z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(z.string().parse(init?.body))),
        client_id: 'fixture-client',
      });
    }
    if (url.pathname === '/oauth/mcp/token') {
      exchanges++;
      assert.ok(init?.body instanceof URLSearchParams);
      const body = init.body;
      verifiedPkce =
        createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url') === challenge &&
        body.get('code') === 'fixture-code' &&
        body.get('redirect_uri') === CALLBACK &&
        body.get('client_id') === 'fixture-client';
      if (options.abortExchange) stop.abort();
      if (options.expire)
        return reply(
          {
            error: 'invalid_grant',
            error_description: 'private-marker-never-log',
          },
          400,
        );
      return reply({
        access_token: 'fake-unit-only-token',
        token_type: 'Bearer',
        scope: 'orchestration:read orchestration:operate',
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const interaction = {
    prepare(s: string, _issuer: string, signal: AbortSignal) {
      callbackState = s;
      const code = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return callbackCode(callback({ state: s }), s, issuer);
      });
      return Promise.resolve({ code });
    },
    redirect(url: URL) {
      challenge = url.searchParams.get('code_challenge') ?? '';
      assert.ok(url.searchParams.get('state') === callbackState);
      assert.ok(
        url.searchParams.get('scope') ===
          'orchestration:read orchestration:operate',
      );
      return Promise.resolve();
    },
  };
  return {
    endpoint,
    transport,
    interaction,
    stop,
    statistics: () => ({ exchanges, registrations, verifiedPkce }),
  };
}
await test('AUTH SDK FIXTURE: official SDK DCR/S256 exchange uses original verifier, state and pinned origin', async () => {
  const f = oauthFixture();
  const value = await authorize(
    f.endpoint,
    f.interaction,
    f.stop.signal,
    f.transport,
  );
  assert.equal(value.environmentId, 'fixture-env');
  assert.deepEqual(f.statistics(), {
    exchanges: 1,
    registrations: 1,
    verifiedPkce: true,
  });
});
await test('AUTH SDK FIXTURE: expired code, wrong issuer, redirected registration and cancellation fail closed without retries', async () => {
  for (const options of [
    { expire: true },
    { wrongIssuer: true },
    { redirectRegistration: true },
    { abortExchange: true },
  ]) {
    const f = oauthFixture(options);
    await assert.rejects(
      authorize(f.endpoint, f.interaction, f.stop.signal, f.transport),
      (e: unknown) =>
        e instanceof Error &&
        e.message ===
          'Owner authorization failed; restart with a fresh request',
    );
    assert.ok(f.statistics().exchanges <= 1);
    if ('expire' in options || 'abortExchange' in options)
      assert.equal(f.statistics().exchanges, 1);
    if ('wrongIssuer' in options) assert.equal(f.statistics().registrations, 0);
  }
});
await test('AUTH FETCH: untrusted origins, redirects and elapsed deadlines never reach an unsafe destination', async () => {
  let calls = 0;
  const stop = new AbortController();
  const transport: FetchLike = () => {
    calls++;
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: 'https://untrusted.invalid' },
      }),
    );
  };
  const guarded = authorizationFetch(issuer + '/mcp', stop.signal, transport);
  await assert.rejects(guarded('https://untrusted.invalid/collect'));
  assert.equal(calls, 0);
  await assert.rejects(
    guarded(issuer + '/.well-known/oauth-authorization-server'),
  );
  assert.equal(calls, 1);
  stop.abort();
  await assert.rejects(guarded(issuer + '/oauth/mcp/token'));
  assert.equal(calls, 1);
});

await test('AUTH FILES: exclusive new publication, private directory/file checks and original grant preservation', () => {
  const f = fixture();
  const value = Credential.parse({
    endpoint: issuer + '/mcp',
    environmentId: 'fixture-env',
    client: { client_id: 'fixture-client' },
    tokens: {
      access_token: 'fake-unit-only-token',
      token_type: 'Bearer',
      scope: 'orchestration:read',
    },
  });
  try {
    const path = join(f.directory, 'private', 'oauth.json');
    credentialDestination(path);
    assert.equal(statSync(join(f.directory, 'private')).mode & 0o777, 0o700);
    saveCredential(path, value, { replace: false });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const before = readFileSync(path);
    assert.throws(() => {
      credentialDestination(path);
    });
    assert.throws(() => {
      saveCredential(path, value, { replace: false });
    });
    assert.ok(before.equals(readFileSync(path)));
    const link = join(f.directory, 'link.json');
    symlinkSync(path, link);
    assert.throws(() => {
      saveCredential(link, value);
    });
    const shared = join(f.directory, 'shared');
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    assert.throws(() => {
      credentialDestination(join(shared, 'oauth.json'));
    });
    const alias = join(f.directory, 'alias');
    symlinkSync(join(f.directory, 'private'), alias);
    assert.throws(() => {
      credentialDestination(join(alias, 'new.json'));
    });
    const foreign = join(f.directory, 'foreign.json');
    writeFileSync(foreign, 'private-marker', { mode: 0o644 });
    // File creation respects the runner's umask; make the unsafe-mode fixture explicit.
    chmodSync(foreign, 0o644);
    assert.throws(() => {
      saveCredential(foreign, value);
    });
    assert.ok(readFileSync(foreign, 'utf8') === 'private-marker');
  } finally {
    f.cleanup();
  }
});
await test('AUTH CLI: manual non-TTY and invalid mode reject before networking with fixed output only', () => {
  for (const mode of ['manual', 'invalid']) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/t3-auth.ts'],
      {
        env: {
          PATH: process.env.PATH ?? '',
          KINMESH_T3_ENDPOINT: 'http://127.0.0.1:1/mcp',
          KINMESH_T3_AUTH_FILE: '/unused/private.json',
          KINMESH_T3_AUTH_MODE: mode,
        },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(result.status, 1);
    assert.ok(result.stdout === '');
    assert.ok(result.stderr.startsWith('T3_AUTH FAIL:'));
    assert.ok(!result.stderr.includes('/unused'));
    assert.ok(!result.stderr.includes('127.0.0.1'));
  }
});
await test('AUTH SMOKE FIXTURE: read/capabilities only, scope distinction, pinning and Full access rejection', async () => {
  const credential = Credential.parse({
    endpoint: issuer + '/mcp',
    environmentId: environment.environmentId,
    client: { client_id: 'fixture-client' },
    tokens: {
      access_token: 'fake-unit-only-token',
      token_type: 'Bearer',
      scope: 'orchestration:read orchestration:operate',
    },
  });
  const wire = new MockWire();
  wire.values.orchestrator_capabilities = {
    ...z
      .record(z.string(), z.unknown())
      .parse(captured.orchestrator_capabilities),
    runtimeMode: 'approval-required',
  };
  assert.equal((await readSmoke(wire, credential)).operate, true);
  assert.deepEqual(
    wire.calls.map((c) => c.name),
    ['t3_environment_read', 'orchestrator_capabilities'],
  );
  assert.equal(
    (
      await readSmoke(wire, {
        ...credential,
        tokens: { ...credential.tokens, scope: 'orchestration:read' },
      })
    ).operate,
    false,
  );
  await assert.rejects(
    readSmoke(wire, { ...credential, environmentId: 'wrong-env' }),
  );
  wire.values.orchestrator_capabilities = {
    ...z
      .record(z.string(), z.unknown())
      .parse(wire.values.orchestrator_capabilities),
    runtimeMode: 'full-access',
  };
  await assert.rejects(readSmoke(wire, credential));
});

await test('AUTH SDK FIXTURE: input deadline cancels a pending owner paste before any exchange', async () => {
  const f = oauthFixture();
  const interaction = {
    prepare() {
      return Promise.resolve({
        code: new Promise<string>(() => {
          /* Simulated absent owner. */
        }),
      });
    },
    redirect() {
      setTimeout(() => {
        f.stop.abort();
      }, 20);
      return Promise.resolve();
    },
  };
  await assert.rejects(
    authorize(f.endpoint, interaction, f.stop.signal, f.transport),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        'Owner authorization failed; restart with a fresh request',
  );
  assert.equal(f.statistics().exchanges, 0);
});
