# T3 external wire fixtures

`t3-0.1.5-tools.json` contains the external MCP `tools/list` schemas captured from the installed official unmodified T3 v0.1.5 through an independently OAuth-authenticated SDK on 2026-10-30. It is contract data, not copied execution implementation. `t3-0.1.5-responses.json` contains actual environment/capability/launch/read/send/wait/interrupt/denial shapes captured over that external connection. Conversation text, IDs, locations and owner labels were deterministically redacted; the provider/model relevant to the test stays explicit. Archive is omitted by the server from output schemas and handled by the adapter's documented cleanup result validator.

Upstream references reviewed **before implementation**, pinned to `v0.1.5`:

- https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/user/outside-agents.md
- https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/orchestration-v2/orchestrator-mcp-server.md
- https://github.com/pingdotgg/t3code/blob/v0.1.5/apps/server/src/mcp/toolkits/project/tools.ts
- https://github.com/pingdotgg/t3code/blob/v0.1.5/packages/contracts/src/orchestratorMcp.ts
- Public thread launch/management service source at the same tag was reviewed for command receipt replay semantics; none is imported or copied into Kinmesh.

Tests named MOCK deliberately mutate these fixtures to exercise failure/timeout/waiting/interrupt-ack branches. Those synthetic variations are not additional captured live outcomes. Native denial fixtures preserve only the machine-readable error code, never native failure prose. No tokens, provider messages, pairing URLs/codes or real user/workspace data should be added. Record compatibility and paid live acceptance separately in PR evidence.
