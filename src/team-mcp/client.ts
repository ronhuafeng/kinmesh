import {
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  constants,
} from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
export const TeamEndpoint = z.url().refine((value) => {
  const u = new URL(value);
  return (
    u.pathname === '/mcp' &&
    u.search === '' &&
    u.hash === '' &&
    u.username === '' &&
    u.password === '' &&
    (u.protocol === 'https:' ||
      (u.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
  );
});
export function loadAgentToken(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error('Unsafe credential file');
    return z
      .strictObject({ token: z.string().regex(/^kma_[A-Za-z0-9_-]{43}$/) })
      .parse(JSON.parse(readFileSync(fd, 'utf8'))).token;
  } finally {
    closeSync(fd);
  }
}
/** Explicit bearer authorization; no cookies, browser fallback or mutation retries. */
export async function connectAgent(endpoint: string, tokenFile: string) {
  const token = loadAgentToken(tokenFile);
  const client = new Client({ name: 'kinmesh-team-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(TeamEndpoint.parse(endpoint)),
    {
      requestInit: { headers: { authorization: 'Bearer ' + token } },
      fetch: (input, init) => {
        const inherited = init?.signal;
        return fetch(input, {
          ...init,
          redirect: 'error',
          signal: inherited
            ? AbortSignal.any([inherited, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        });
      },
    },
  );
  try {
    await client.connect(transport);
    return client;
  } catch {
    await client.close();
    throw new Error('Team authentication or connection failed');
  }
}
