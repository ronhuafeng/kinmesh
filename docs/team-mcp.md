# Kinmesh Team MCP

Team MCP is a standalone agent collaboration service over Kinmesh's authoritative repositories. It is separate from T3's orchestration MCP and uses official `@modelcontextprotocol/sdk` **1.32.2** Streamable HTTP with Zod input/output schemas. It adds no database tables, execution harness, private T3 interfaces or provider adapter.

## Secure local setup

Use Node 24 and the normal owner bootstrap/login flow from the README. Through the protected human API, create an agent, enroll it in a channel and issue an expiring grant. Read-only collaboration needs `channels:read`; tasks additionally need `tasks:read`. Posting/topic creation needs `channels:write`; task creation/claim/progress/handoff/reference linking needs `tasks:write`; technical review needs `tasks:review`. Scope never substitutes for channel membership or task assignment. The existing grant allowlist is unchanged.

Save the once-issued token as `{"token":"<privately issued value>"}` in a private mode 0600 file inside a mode 0700 directory, for example `.store/team-agent.json`. Do not put tokens in command arguments, source, logs, tool inputs or public env files. Obtain the issuance response through a trusted client that writes directly to a protected file, then locally project only the token into this file; never display it. Owner cookie/password auth and credential issuance remain on the human HTTP service, not MCP.

```dotenv
KINMESH_DATABASE=.store/kinmesh.sqlite
KINMESH_TEAM_MCP_PORT=3001
KINMESH_TEAM_MCP_ORIGIN=http://127.0.0.1:3001
KINMESH_TEAM_MCP_CONCURRENCY=16
KINMESH_TEAM_MCP_ENDPOINT=http://127.0.0.1:3001/mcp
KINMESH_TEAM_MCP_TOKEN_FILE=.store/team-agent.json
```

```sh
npm ci
npm run team:mcp        # separate terminal; same Kinmesh database as the human service
npm run team:smoke      # independent SDK initialize/ping/list/channel read; no mutations
```

The service applies existing migrations before listening. It requires only the database/Team MCP configuration, not setup/session secrets. The smoke CLI loads its own private credential file, rejects symlinks, non-owner/world-readable or oversized files, rejects unsafe endpoint URLs and redirects, and prints only fixed PASS/FAIL. No credentials or channel contents are printed. Startup, auth failure and errors also omit request contents/internal diagnostics. Protect DB/WAL/backups as team data.

## Transport and authority

`POST /mcp` is an official SDK **stateless Streamable HTTP** endpoint. SDK instances/transports are created and closed per request; no session IDs are issued or cached. Standard SDK clients initialize, send `notifications/initialized` (202 acknowledgement), list/call tools and ping. Existing clients can reconnect after server restart with their credential. There is no background event stream, resumption store or session deletion; GET/DELETE return 405 with Allow: POST. Session headers/metadata never confer identity. This mode deliberately trades server-initiated notifications/session memory for bounded request processing and simple revocation semantics.

Each HTTP request requires `Authorization: Bearer <agent-token>` and resolves the current hashed grant and active agent. Missing, unknown, expired, disabled or revoked credentials return HTTP 401 with `WWW-Authenticate: Bearer realm="kinmesh-team"`. Each tool callback resolves the bearer again and repositories check current scope/team/channel/task authority inside their transaction. Discovery is a static catalog and does not establish privilege. Human cookies and actor/member headers are rejected. TeamId comes only from the authenticated grant; current actor never comes from a tool argument, query, metadata or declared role. Assignment/mention IDs are targets only. Human accept/rework/cancel and membership/credential administration tools are intentionally absent.

The listener binds **127.0.0.1** only. Plaintext client URLs must use `http://127.0.0.1:<port>/mcp`; `http://localhost` and `http://[::1]` are not supported. Operator HTTPS reverse-proxy URLs remain supported. Host must match the configured public origin's host or exact loopback host/port. An Origin header, when present, must exactly match the configured origin; null/foreign origins and query-bearing endpoint URLs are rejected. There is no CORS or cookie authentication. Request bodies are capped at 16 KiB, rate limit 600 requests/minute per directly connected IP, request/connection timeout 10 s, and active SDK processing defaults to 16 requests (configurable 1–64); overload returns 503. The process caps accepted TCP connections at 128. JSON results are noncacheable. These are local protections, not a distributed quota/sandbox.

For external clients, put a same-host HTTPS reverse proxy in front of loopback, preserve the configured public Host, set `KINMESH_TEAM_MCP_ORIGIN=https://your-team-host.example`, and use `https://your-team-host.example/mcp` in clients. Never expose plain HTTP on a LAN or publish credentials. Forwarded headers are not trusted; proxy connections share a rate-limit bucket. TLS, proxy body/connection limits and remote access policy are operator responsibilities. The server implements existing Kinmesh opaque bearer grants, **not OAuth discovery/login**. Configure a provider that supports explicit HTTP bearer/environment headers; OAuth-only clients cannot authenticate to this service.

A stolen opaque bearer works until revoked/expired. Use separate narrowly scoped credentials per agent/provider, protect host configuration and revoke/disable on compromise. Rotation/revocation uses the existing human-owner API; reconnection cannot restore a revoked grant. No shared production credential rotation is needed for tests.

## Tools and results

All input objects are strict, bounded Zod schemas advertised by `tools/list`, and all successful repository outputs are runtime-validated before returning. There is no direct SQL or duplicated collaboration state in the tool layer. Mutations carry existing operation keys; no implicit mutation retries occur. Use stable resource IDs from reads.

| Tool                       | Input beyond shared fields                       | Authority                                               |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `team_channels_list`       | Optional limit/cursor                            | channels:read; joined channels only                     |
| `team_channel_get`         | channelId                                        | channels:read + joined                                  |
| `team_topics_list`         | channelId, optional limit/cursor                 | channels:read + joined                                  |
| `team_topic_create`        | channelId, operationKey, title                   | channels:write + read/joined                            |
| `team_messages_read`       | channelId, optional topicId/limit/cursor         | channels:read + joined                                  |
| `team_message_get`         | channelId, messageId                             | channels:read + joined                                  |
| `team_messages_send`       | channelId plus existing PostInput                | channels:write + read/joined                            |
| `team_tasks_list`          | channelId, optional limit/cursor                 | tasks:read + channel access                             |
| `team_task_get`            | channelId, taskId                                | tasks:read + channel access                             |
| `team_tasks_history`       | channelId, taskId, optional limit/cursor         | tasks:read + channel access                             |
| `team_task_executions`     | channelId, taskId, optional limit/cursor         | tasks:read + channel access                             |
| `team_task_create`         | channelId plus existing TaskCreate               | tasks:write/read + channel access; self/unassigned only |
| `team_task_claim`          | channelId, taskId, operationKey, expectedVersion | tasks:write/read; open/unowned SQL CAS                  |
| `team_task_progress`       | Common task command + note                       | current work owner; tasks:write/read                    |
| `team_task_handoff`        | Common command + recipient, mode, note           | current work owner; tasks:write/read                    |
| `team_task_request_review` | Common command + reviewer, note                  | current work owner; tasks:write/read                    |
| `team_task_review`         | Common command + decision, note                  | assigned reviewer; tasks:review/read                    |
| `team_task_link_execution` | Common command + reference, note                 | work owner/pending reviewer; tasks:write/read           |

Common task command fields are channelId/taskId/operationKey/expectedVersion. Route/tool name supplies action; never send `type` or actor IDs. See [message DTOs/causality/pagination](channels-messages.md), [task transitions and precise human policy](tasks.md), and [grant/identity APIs](agent-identities.md) for complete domain contracts. Bounded cursors have the same authorization and snapshot semantics as HTTP.

Results provide `structuredContent` and an identical JSON text content block for compatible clients:

```text
{"result":{"ok":true,"data":<validated DTO or page>}}
{"result":{"ok":false,"error":{"code":"forbidden","message":"Permission denied"}}}
```

Expected tool failures use `isError:true`, with fixed `invalid_input`, `unauthenticated`, `forbidden`, `not_found`, `conflict` or `internal` codes and no protected data. Transport credential denial is HTTP 401 before tool decoding; in-callback denial uses the structured error. Invalid or wrong-context snapshot cursors map domain HTTP 400 to `invalid_input / Invalid input` without echoing the cursor. Invalid tool schemas/unknown tools are handled by the SDK's standard error results, not a handwritten JSON-RPC router. Internal failures are redacted. Treat SDK/protocol errors separately from business denial; a network failure is never proof of denied authority.

Message posting and task commands reuse the same principal/action/target-scoped durable receipts and atomic outbox/audit as HTTP. Retry the exact same operationKey/payload/expectedVersion after an ambiguous response; changed input under that key conflicts 409. A replay returns the original authorized snapshot, not a promise it is the newest task revision; read again for current state. Human/agent author provenance is derived server-side. Reviewer approval reaches awaiting-human only; no provider result or MCP tool accepts a task.

## Provider configuration and genuine T3 gate

A generic compatible SDK/provider client configures the Team MCP URL and a dedicated agent's bearer credential. For Codex, use its documented `mcp_servers.<name>` HTTP configuration with `url` and `bearer_token_env_var` (or an environment header), keeping the actual token in a protected process environment/file. Check the installed provider's supported options. Do not copy a token into launch arguments or a prompt, or run an untrusted wrapper.

The pinned upstream T3 Code v0.1.5 [Codex guide](https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/user/providers-codex.md) and [provider setup](https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/user/install.md#providers) describe provider-instance configuration. In the pinned [Codex adapter](https://github.com/pingdotgg/t3code/blob/v0.1.5/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts), `codexThreadConfig` overrides only `mcp_servers.t3-code` and preserves external launch-argument servers. **T3's own MCP is not Team MCP.** The [outside-agents guide](https://github.com/pingdotgg/t3code/blob/v0.1.5/docs/user/outside-agents.md) describes external orchestration callers, not automatic outbound Kinmesh configuration.

On this version, the advertised `t3_thread_launch` schema offers project/scratch/model selection and runtime mode, but no dedicated per-run Team MCP endpoint/credential configuration field. A generic `modelSelection.options` object is not evidence of supported credential injection. A provider selected for the live test must already be securely configured to reach the temporary Team endpoint with that disposable grant. Do not change shared provider homes, global credentials or T3 internals to manufacture acceptance. If an isolated configuration cannot be supplied through supported owner-managed settings, the provider gate remains blocked.

The reproducible live runner is separate from the credential-free SDK process tests. Prepare a disposable fixture (no provider calls):

```sh
export KINMESH_TEAM_LIVE_DIR=/tmp/kinmesh-team-live-owner  # NEW directory; preparation refuses overwrite
export KINMESH_TEAM_MCP_ENDPOINT=http://127.0.0.1:3001/mcp
npm run team:live:prepare
# Start Team MCP in another terminal using this database:
KINMESH_DATABASE="$KINMESH_TEAM_LIVE_DIR/team.sqlite" npm run team:mcp
```

Preparation creates a private disposable human/team/channel, Developer and Reviewer identities, one-hour Developer credential (`developer.json`), source message, unclaimed task and `context.json`. It prints no credentials or team contents. Configure a **dedicated isolated T3 provider instance** through supported operator settings for that exact endpoint and grant. It must load the credential privately; this repository never edits the shared provider's configuration. Use the existing [secure T3 OAuth flow](t3-adapter.md) to provide an approved operate-scoped external grant. Set:

```dotenv
KINMESH_TEAM_T3_LIVE=1
KINMESH_TEAM_LIVE_DIR=/tmp/kinmesh-team-live-owner
KINMESH_TEAM_T3_ISOLATED_PROVIDER=your-isolated-provider-instance-id
KINMESH_T3_ENDPOINT=https://your-owner-private-t3-origin.example/mcp
KINMESH_T3_AUTH_FILE=.store/t3-owner-oauth.json
KINMESH_T3_MODEL=your-advertised-model-id
```

```sh
npm run test:team-live
```

This gate launches exactly one scratch provider turn through the existing external T3 OAuth SDK adapter. Only the provider is instructed to mutate Team MCP: read the seeded message, post a nonce plus the unprompted read proof, claim the disposable task and hand off to Reviewer. The gate itself performs Team reads only, then verifies native runId/terminal completion/no pending requests and persisted attributed message/task audit through independent authorized reads. It neither edits files nor accepts tasks; it attempts stop/archive cleanup through existing external tools and reports cleanup failure privately with fixed text. Inspect disposable resources through the owner interface after failures; preparation must not overwrite/reuse a partly consumed task.

Missing opt-in, configuration, OAuth, provider capability, read proof, persisted effects or real completion makes the gate exit 1. It never silently skips/green-lights a missing provider. Current implementation review must distinguish the witnessed independent SDK process tests from an unwitnessed configured-provider gate. Neither credential-free CI nor Runner gates prove a T3-launched agent used Team MCP. The gate's fully configured provider path still requires actual operator validation; no native provider success is inferred from fixture or mock tests.

## Validation and limits

`npm run test:team-mcp` runs actual child-server and independent official SDK client tests, including separate client-process claims. `npm run check` includes them alongside all existing domain/HTTP/adapter tests; CI runs that suite on clean checkout with no private credentials. `npm run team:smoke` is a read-only operator check. `npm run test:team-live` is the explicit paid/provider gate; `npm run release:check` requires it in addition to the existing T3 execution gate.

Team MCP itself provides no worker or execution interface; optional wake/delivery is provided by the [Agent Inbox worker](agent-inbox.md). No UI, Team OAuth authorization server, AG-UI streaming, PR automation or remote multi-node database is supplied. Native provider configuration and permission ceilings remain authoritative; do not silently approve tools or treat reviewer/model feedback as human acceptance. The database remains the local single-node WAL system, with its documented operational limits.
