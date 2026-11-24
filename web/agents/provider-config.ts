/**
 * What a provider adds to its own configuration to work with the team as
 * this agent through Team MCP, with Kinmesh's tools let through without
 * asking a person (docs/t3.md#provider-configuration); null for a kind of
 * provider Kinmesh has none for.
 */
export function providerConfig(
  driver: string,
  url: string,
  token: string,
): string | null {
  if (driver !== 'codex') return null;
  // A JSON string is a TOML basic string.
  return [
    '[mcp_servers.kinmesh]',
    `url = ${JSON.stringify(url)}`,
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`,
    'default_tools_approval_mode = "approve"',
    '',
  ].join('\n');
}
