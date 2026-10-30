import { z } from 'zod';
import { connectAgent, TeamEndpoint } from '../src/team-mcp/client.js';
import { outcome } from '../src/team-mcp/tools.js';
import { ChannelView, pageOf } from '../src/domain/communication.js';
let client: Awaited<ReturnType<typeof connectAgent>> | undefined;
try {
  const config = z
    .object({
      KINMESH_TEAM_MCP_ENDPOINT: TeamEndpoint,
      KINMESH_TEAM_MCP_TOKEN_FILE: z.string().min(1),
    })
    .parse(process.env);
  client = await connectAgent(
    config.KINMESH_TEAM_MCP_ENDPOINT,
    config.KINMESH_TEAM_MCP_TOKEN_FILE,
  );
  await client.ping();
  const listed = await client.listTools();
  if (!listed.tools.some((t) => t.name === 'team_channels_list'))
    throw new Error('Missing tool');
  const response = await client.callTool({
    name: 'team_channels_list',
    arguments: { limit: 1 },
  });
  const read = outcome(pageOf(ChannelView)).parse(response.structuredContent);
  if (!read.result.ok) throw new Error('Read denied');
  console.info('TEAM_MCP_SDK_READ PASS');
} catch {
  console.error(
    'TEAM_MCP_SDK_READ FAIL: requires a reachable endpoint and a private active channels:read agent grant file.',
  );
  process.exitCode = 1;
} finally {
  await client?.close();
}
