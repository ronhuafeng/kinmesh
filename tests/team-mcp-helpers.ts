import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { outcome } from '../src/team-mcp/tools.js';
export async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Port unavailable');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((e) => {
      if (e) reject(e);
      else resolve();
    }),
  );
  return port;
}
export async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    await exit;
  } finally {
    clearTimeout(timer);
  }
}
export async function startTeam(path: string, port: number) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/team-mcp/main.ts'],
    {
      env: {
        ...process.env,
        KINMESH_DATABASE: path,
        KINMESH_TEAM_MCP_PORT: String(port),
        KINMESH_TEAM_MCP_ORIGIN: `http://127.0.0.1:${String(port)}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr.resume(); // Never report raw startup errors/credentials.
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Team process readiness timeout'));
      }, 10000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Kinmesh Team MCP ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Team process failed'));
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('Team process failed'));
      });
    });
  } catch (e) {
    await stop(child);
    throw e;
  }
  return child;
}
export async function connectTeam(endpoint: string, token: string) {
  const client = new Client({
    name: 'independent-team-test',
    version: '1.0.0',
  });
  const statuses: number[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, redirect: 'error' });
      statuses.push(response.status);
      return response;
    },
    requestInit: { headers: { authorization: 'Bearer ' + token } },
  });
  await client.connect(transport);
  return { client, transport, statuses };
}
export async function call<T extends z.ZodType>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  schema: T,
) {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }),
  );
  return outcome(schema).parse(result.structuredContent).result;
}
