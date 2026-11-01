import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import {
  preflight,
  PREFLIGHT_TIMEOUT_MS,
} from '../src/adapters/t3/preflight.js';

const RESOURCE = '/.well-known/oauth-protected-resource';
const METADATA = '/.well-known/oauth-authorization-server';
const DESCRIPTOR = '/.well-known/t3/environment';
const SCOPES = ['orchestration:read', 'orchestration:operate'];
const PASS =
  'T3_PREFLIGHT PASS: public network, issuer and capability readiness only; OAuth authentication not verified.\n';
const FAIL =
  'T3_PREFLIGHT FAIL: public readiness not verified; no OAuth authentication attempted.\n';
const redacted = (error: unknown) =>
  error instanceof Error && error.message === 'T3 preflight rejected';
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  stall?: 'headers' | 'body';
  delay?: number;
  raw?: string;
}
function patch(reply: Reply, changes: Record<string, unknown>): Reply {
  assert.ok(reply.body && typeof reply.body === 'object');
  return { ...reply, body: { ...reply.body, ...changes } };
}

/** Local HTTP fixture only: no T3 process, credentials, providers or model runs. */
async function fixture(
  rewrite: (path: string, reply: Reply, origin: string) => Reply = (
    _path,
    reply,
  ) => reply,
) {
  let origin = '';
  const calls: {
    path: string;
    method: string | undefined;
    headers: IncomingHttpHeaders;
  }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    calls.push({ path, method: request.method, headers: request.headers });
    let reply: Reply = {
      status: 500,
      body: { private: 'fixture-private-marker' },
    };
    if (path === '/mcp')
      reply = {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${origin}${RESOURCE}"`,
        },
        body: { private: 'fixture-private-marker' },
      };
    if (path === RESOURCE + '/mcp') reply = { status: 404 };
    if (path === RESOURCE)
      reply = {
        status: 200,
        body: {
          resource: origin + '/mcp',
          authorization_servers: [origin],
          scopes_supported: SCOPES,
          bearer_methods_supported: ['header'],
          resource_name: 'T3 Code',
        },
      };
    if (path === METADATA)
      reply = {
        status: 200,
        body: {
          issuer: origin,
          authorization_endpoint: origin + '/oauth/mcp/authorize',
          token_endpoint: origin + '/oauth/mcp/token',
          registration_endpoint: origin + '/oauth/mcp/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: SCOPES,
          authorization_response_iss_parameter_supported: true,
        },
      };
    if (path === DESCRIPTOR)
      reply = {
        status: 200,
        body: {
          environmentId: 'fixture-private-environment',
          serverVersion: '0.1.5',
        },
      };
    reply = rewrite(path, reply, origin);
    const send = () => {
      if (reply.stall === 'headers') return;
      response.writeHead(reply.status, {
        'content-type': 'application/json',
        'set-cookie': 'fixture-private-cookie=never-forward',
        ...reply.headers,
      });
      if (reply.stall === 'body') {
        response.write('{');
        return;
      }
      response.end(
        reply.raw ??
          (reply.body === undefined ? '' : JSON.stringify(reply.body)),
      );
    };
    if (reply.delay) timers.add(setTimeout(send, reply.delay));
    else send();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    endpoint: origin + '/mcp',
    origin,
    calls,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
    },
  };
}
function onlyPublicGets(calls: Awaited<ReturnType<typeof fixture>>['calls']) {
  assert.ok(calls.length <= 5);
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.ok(
      ['/mcp', DESCRIPTOR, RESOURCE + '/mcp', RESOURCE, METADATA].includes(
        call.path,
      ),
    );
    for (const name of [
      'authorization',
      'cookie',
      'proxy-authorization',
      'referer',
    ])
      assert.equal(call.headers[name], undefined);
  }
}

await test('PREFLIGHT LOCAL FIXTURE: v0.1.5 readiness, standard SDK fallback, only public GETs and no inherited cookies', async () => {
  const local = await fixture();
  try {
    await preflight(local.endpoint);
    assert.deepEqual(
      local.calls.map((call) => call.path),
      ['/mcp', DESCRIPTOR, RESOURCE + '/mcp', RESOURCE, METADATA],
    );
    onlyPublicGets(local.calls);
  } finally {
    await local.close();
  }
});

const failures: {
  name: string;
  path: string;
  rewrite: (reply: Reply) => Reply;
}[] = [
  {
    name: 'wrong issuer',
    path: METADATA,
    rewrite: (r) => patch(r, { issuer: 'https://untrusted.invalid' }),
  },
  {
    name: 'wrong resource',
    path: RESOURCE,
    rewrite: (r) => patch(r, { resource: 'https://untrusted.invalid/mcp' }),
  },
  {
    name: 'multiple issuers',
    path: RESOURCE,
    rewrite: (r) =>
      patch(r, {
        authorization_servers: [
          'https://untrusted.invalid',
          'https://another.invalid',
        ],
      }),
  },
  {
    name: 'wrong version',
    path: DESCRIPTOR,
    rewrite: (r) => patch(r, { serverVersion: '0.1.4' }),
  },
  {
    name: 'malformed version',
    path: DESCRIPTOR,
    rewrite: (r) => patch(r, { serverVersion: '0.1.6-beta' }),
  },
  {
    name: 'missing environment ID',
    path: DESCRIPTOR,
    rewrite: (r) => patch(r, { environmentId: '' }),
  },
  {
    name: 'whitespace environment ID',
    path: DESCRIPTOR,
    rewrite: (r) => patch(r, { environmentId: ' ' }),
  },
  {
    name: 'missing S256',
    path: METADATA,
    rewrite: (r) => patch(r, { code_challenge_methods_supported: ['plain'] }),
  },
  {
    name: 'missing issuer-response support',
    path: METADATA,
    rewrite: (r) =>
      patch(r, { authorization_response_iss_parameter_supported: false }),
  },
  {
    name: 'wrong authorize endpoint',
    path: METADATA,
    rewrite: (r) =>
      patch(r, {
        authorization_endpoint: 'https://untrusted.invalid/authorize',
      }),
  },
  {
    name: 'wrong token endpoint',
    path: METADATA,
    rewrite: (r) =>
      patch(r, { token_endpoint: 'https://untrusted.invalid/token' }),
  },
  {
    name: 'wrong registration endpoint',
    path: METADATA,
    rewrite: (r) =>
      patch(r, { registration_endpoint: 'https://untrusted.invalid/register' }),
  },
  {
    name: 'missing AS operate scope',
    path: METADATA,
    rewrite: (r) => patch(r, { scopes_supported: ['orchestration:read'] }),
  },
  {
    name: 'missing resource read scope',
    path: RESOURCE,
    rewrite: (r) => patch(r, { scopes_supported: ['orchestration:operate'] }),
  },
  {
    name: 'missing public-client support',
    path: METADATA,
    rewrite: (r) =>
      patch(r, {
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      }),
  },
  {
    name: 'missing code response',
    path: METADATA,
    rewrite: (r) => patch(r, { response_types_supported: ['token'] }),
  },
  {
    name: 'missing code grant',
    path: METADATA,
    rewrite: (r) => patch(r, { grant_types_supported: ['client_credentials'] }),
  },
  {
    name: 'missing header bearer support',
    path: RESOURCE,
    rewrite: (r) => patch(r, { bearer_methods_supported: ['query'] }),
  },
  {
    name: 'MCP unexpectedly public 200',
    path: '/mcp',
    rewrite: (r) => ({ ...r, status: 200 }),
  },
  {
    name: 'MCP missing challenge',
    path: '/mcp',
    rewrite: (r) => ({ ...r, headers: {} }),
  },
  {
    name: 'MCP Basic challenge',
    path: '/mcp',
    rewrite: (r) => ({
      ...r,
      headers: { 'www-authenticate': 'Basic realm="fixture"' },
    }),
  },
  { name: '502 MCP', path: '/mcp', rewrite: (r) => ({ ...r, status: 502 }) },
  {
    name: '502 descriptor',
    path: DESCRIPTOR,
    rewrite: (r) => ({ ...r, status: 502 }),
  },
  {
    name: '502 resource cannot become SDK fallback success',
    path: RESOURCE + '/mcp',
    rewrite: (r) => ({ ...r, status: 502 }),
  },
  { name: '502 AS', path: METADATA, rewrite: (r) => ({ ...r, status: 502 }) },
  {
    name: 'missing resource cannot become legacy success',
    path: RESOURCE,
    rewrite: (r) => ({ ...r, status: 404 }),
  },
  {
    name: 'missing AS cannot become OIDC success',
    path: METADATA,
    rewrite: (r) => ({ ...r, status: 404 }),
  },
  {
    name: 'non-JSON descriptor',
    path: DESCRIPTOR,
    rewrite: (r) => ({ ...r, headers: { 'content-type': 'text/html' } }),
  },
  {
    name: 'malformed JSON',
    path: RESOURCE,
    rewrite: (r) => ({ ...r, raw: '{fixture-private-marker' }),
  },
  {
    name: 'oversize metadata',
    path: RESOURCE,
    rewrite: (r) => patch(r, { padding: 'x'.repeat(65_537) }),
  },
];
for (const failure of failures) {
  await test('PREFLIGHT LOCAL FIXTURE rejects ' + failure.name, async () => {
    const local = await fixture((path, reply) =>
      path === failure.path ? failure.rewrite(reply) : reply,
    );
    try {
      await assert.rejects(preflight(local.endpoint), redacted);
      onlyPublicGets(local.calls);
    } finally {
      await local.close();
    }
  });
}

await test('PREFLIGHT LOCAL FIXTURE: cross-origin metadata and all redirects never reach another listener', async () => {
  const trap = await fixture();
  try {
    for (const path of [
      '/mcp',
      DESCRIPTOR,
      RESOURCE + '/mcp',
      RESOURCE,
      METADATA,
      'cross-origin-issuer',
    ]) {
      const local = await fixture((actual, reply) => {
        if (path === 'cross-origin-issuer' && actual === RESOURCE)
          return patch(reply, { authorization_servers: [trap.origin] });
        return actual === path
          ? { status: 302, headers: { location: trap.endpoint } }
          : reply;
      });
      try {
        await assert.rejects(preflight(local.endpoint), redacted);
        onlyPublicGets(local.calls);
        assert.equal(trap.calls.length, 0);
      } finally {
        await local.close();
      }
    }
  } finally {
    await trap.close();
  }
});

await test('PREFLIGHT LOCAL FIXTURE: malicious issuer paths, credentials, query and hash never reach OAuth action endpoints', async () => {
  for (const suffix of [
    '/oauth/mcp/register',
    '/oauth/mcp/token',
    '/oauth/mcp/authorize',
    '/mcp',
    '/?secret=fixture-private-marker',
    '/#fragment',
  ]) {
    const local = await fixture((path, reply, origin) =>
      path === RESOURCE
        ? patch(reply, { authorization_servers: [origin + suffix] })
        : reply,
    );
    try {
      await assert.rejects(preflight(local.endpoint), redacted);
      onlyPublicGets(local.calls);
    } finally {
      await local.close();
    }
  }
  const local = await fixture((path, reply, origin) =>
    path === RESOURCE
      ? patch(reply, {
          authorization_servers: [
            origin.replace('127.0.0.1', 'fixture-private-marker@127.0.0.1'),
          ],
        })
      : reply,
  );
  try {
    await assert.rejects(preflight(local.endpoint), redacted);
    onlyPublicGets(local.calls);
  } finally {
    await local.close();
  }
});

await test('PREFLIGHT LOCAL FIXTURE: strict endpoint canonicalization rejects before any HTTP', async () => {
  const local = await fixture();
  try {
    for (const endpoint of [
      local.endpoint + '?secret=fixture-private-marker',
      local.endpoint + '#',
      local.endpoint + '/',
      local.endpoint.replace('/mcp', '/x/../mcp'),
      local.endpoint.replace('127.0.0.1', 'user@127.0.0.1'),
      local.endpoint.replace('127.0.0.1', '127.1'),
      ' ' + local.endpoint,
      local.endpoint + '\n',
      local.endpoint.replace('http:', 't3-thread:'),
      'http://untrusted.invalid/mcp',
      '',
    ])
      await assert.rejects(preflight(endpoint), redacted);
    assert.equal(local.calls.length, 0);
  } finally {
    await local.close();
  }
});

await test('PREFLIGHT LOCAL FIXTURE: one total deadline bounds initial connect/headers and stalled bodies at every discovery stage', async () => {
  for (const [path, stall] of [
    ['/mcp', 'headers'],
    [DESCRIPTOR, 'body'],
    [RESOURCE, 'body'],
    [METADATA, 'body'],
  ] as const) {
    const local = await fixture((actual, reply) =>
      actual === path ? { ...reply, stall } : reply,
    );
    try {
      const start = performance.now();
      await assert.rejects(preflight(local.endpoint, 150), redacted);
      assert.ok(performance.now() - start < 2500);
      onlyPublicGets(local.calls);
    } finally {
      await local.close();
    }
  }
  const local = await fixture((_path, reply) => ({ ...reply, delay: 100 }));
  try {
    const start = performance.now();
    await assert.rejects(preflight(local.endpoint, 350), redacted);
    assert.ok(performance.now() - start < 2500);
    assert.ok(local.calls.length < 5);
    onlyPublicGets(local.calls);
  } finally {
    await local.close();
  }
  assert.equal(PREFLIGHT_TIMEOUT_MS, 10_000);
});

async function cli(endpoint: string, args: string[] = []) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/t3-preflight.ts', ...args],
    {
      env: {
        KINMESH_T3_ENDPOINT: endpoint,
        KINMESH_T3_AUTH_FILE: '/never-read-fixture-private-marker',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (value: string) => {
    stdout += value;
  });
  child.stderr.setEncoding('utf8').on('data', (value: string) => {
    stderr += value;
  });
  const code: unknown = (await once(child, 'close'))[0];
  assert.ok(typeof code === 'number');
  return { code, stdout, stderr };
}
await test('PREFLIGHT CLI LOCAL FIXTURE: fixed output and exit codes never expose host, JSON, environment, errors or supplied private input', async () => {
  const local = await fixture();
  try {
    assert.deepEqual(await cli(local.endpoint), {
      code: 0,
      stdout: PASS,
      stderr: '',
    });
    onlyPublicGets(local.calls);
    assert.deepEqual(
      await cli(local.endpoint + '?private=fixture-private-marker'),
      { code: 1, stdout: '', stderr: FAIL },
    );
    assert.deepEqual(await cli(''), { code: 1, stdout: '', stderr: FAIL });
    assert.deepEqual(await cli(local.endpoint, ['fixture-private-marker']), {
      code: 1,
      stdout: '',
      stderr: FAIL,
    });
    assert.equal(local.calls.length, 5);
  } finally {
    await local.close();
  }
  const bad = await fixture((path, reply) =>
    path === DESCRIPTOR ? { ...reply, status: 502 } : reply,
  );
  try {
    assert.deepEqual(await cli(bad.endpoint), {
      code: 1,
      stdout: '',
      stderr: FAIL,
    });
    onlyPublicGets(bad.calls);
  } finally {
    await bad.close();
  }
});

await test('PREFLIGHT CLI LOCAL FIXTURE: the real default deadline terminates stalled initialization with fixed failure', async () => {
  const local = await fixture((path, reply) =>
    path === '/mcp' ? { ...reply, stall: 'headers' } : reply,
  );
  try {
    const start = performance.now();
    assert.deepEqual(await cli(local.endpoint), {
      code: 1,
      stdout: '',
      stderr: FAIL,
    });
    assert.ok(performance.now() - start < 14_000);
    assert.deepEqual(
      local.calls.map((call) => call.path),
      ['/mcp'],
    );
    onlyPublicGets(local.calls);
  } finally {
    await local.close();
  }
});
