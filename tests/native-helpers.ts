import { createServer } from 'node:http';
import { z } from 'zod';
import { Credential } from '../src/adapters/t3/oauth.js';
import { ToolList } from '../src/adapters/t3/contracts.js';
import { captured, schemas } from './t3-helpers.js';

/** Deterministic local MCP protocol fixture. No T3 installation, OAuth grant or model. */
export async function mockNativeServer() {
  const calls: { name: string; args: unknown }[] = [];
  const requests: { path: string; authorization: string | undefined }[] = [];
  const hooks: { beforeThreadRead?: () => void } = {};
  const mode = {
    value: 'normal' as
      | 'normal'
      | 'unauthorized'
      | 'forbidden'
      | 'redirect'
      | 'hang'
      | 'wrong-environment'
      | 'bad-read',
  };
  const server = createServer((request, response) => {
    requests.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
    });
    if (mode.value === 'hang') return;
    if (mode.value === 'unauthorized' || mode.value === 'forbidden') {
      response
        .writeHead(mode.value === 'forbidden' ? 403 : 401, {
          'www-authenticate':
            'Bearer resource_metadata="https://untrusted.invalid/oauth"',
        })
        .end();
      return;
    }
    if (mode.value === 'redirect') {
      response.writeHead(307, { location: '/redirect-target' }).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const rpc = z
        .object({
          id: z.union([z.string(), z.number()]).optional(),
          method: z.string(),
          params: z.unknown().optional(),
        })
        .parse(JSON.parse(body));
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'MOCK-local-native-reader', version: '0.1.5' },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: ToolList.parse(schemas).tools.filter((tool) =>
            ['t3_environment_read', 't3_thread_read'].includes(tool.name),
          ),
        };
      else if (rpc.method === 'tools/call') {
        const params = z
          .object({ name: z.string(), arguments: z.unknown() })
          .parse(rpc.params);
        calls.push({ name: params.name, args: params.arguments });
        const raw = structuredClone(captured[params.name]);
        if (
          params.name === 't3_environment_read' &&
          mode.value === 'wrong-environment'
        ) {
          result = {
            structuredContent: {
              environmentId: 'wrong',
              serverVersion: '0.1.5',
            },
            content: [],
          };
        } else if (params.name === 't3_thread_read') {
          hooks.beforeThreadRead?.();
          const data = z
            .object({ thread: z.record(z.string(), z.unknown()) })
            .loose()
            .parse(raw);
          data.thread.link = `${origin}/${capturedEnvironment.environmentId}/${String(data.thread.threadId)}`;
          result = {
            structuredContent: mode.value === 'bad-read' ? {} : data,
            content: [],
          };
        } else result = { structuredContent: raw, content: [] };
      } else {
        response.writeHead(400).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  const capturedEnvironment = z
    .object({ environmentId: z.string() })
    .parse(captured.t3_environment_read);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No mock listener');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const endpoint = origin + '/mcp';
  const credential = Credential.parse({
    endpoint,
    environmentId: capturedEnvironment.environmentId,
    client: { client_id: 'local-unit-client' },
    tokens: {
      access_token: 'MOCK-unit-token-no-provider',
      token_type: 'Bearer',
      scope: 'orchestration:read',
    },
  });
  return {
    origin,
    endpoint,
    credential,
    mode,
    calls,
    requests,
    hooks,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    },
  };
}
