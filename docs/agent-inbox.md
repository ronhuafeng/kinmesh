# Agent Inbox and worker

The Inbox connects committed collaboration facts to the existing external T3 adapter. SQLite owns source facts, delivery identity, scheduling, claims, correlations and publication. Independently installed, unmodified T3 owns native execution. The standalone Team MCP remains the external collaboration service; the worker neither exposes another MCP service nor implements provider sessions, native approvals or task acceptance.

## Ordinary deployment

Execution is optional. With `KINMESH_INBOX_CONFIG` **absent**, `npm start` starts only the human service and needs no worker/T3 credentials. With that variable set to a private worker configuration, ordinary startup also supervises a separate Inbox child process. Team MCP (`npm run team:mcp`) always remains a separate service. All components use the **same local database**.

Alternatively, leave the variable absent from the human service and supervise `npm run inbox:worker` independently. Choose one ordinary deployment arrangement; do not accidentally start both. Intentional worker replicas still share the existing SQLite capacity and leases. Neither arrangement uses durable PID files or a resident model process.

Use Node 24 and `npm ci`, then the owner bootstrap/login/enrollment APIs in the [identity](agent-identities.md), [channel](channels-messages.md) and [task](tasks.md) guides. For each worker-bound agent:

1. Enroll the active agent in its channels. Set its profile preferences to the **actual primary T3 environment ID**, dedicated isolated Provider instance ID and advertised model ID. This worker uses scratch launches on that primary environment; linked environments/projects/resume-in-place are outside this worker's supported policy.
2. Issue a dedicated expiring Kinmesh credential with `channels:read`, `channels:write`, `executions:write`. Task wakes additionally require `tasks:read`, `tasks:write`; technical review performed through Team MCP additionally requires `tasks:review`. Operational correlation reads require `executions:read`. These scopes are independent of channel membership and task assignment. Save only `{"token":"<once-issued value>"}` privately. Never log issuance responses or put tokens on command lines.
3. Obtain an owner-approved external T3 OAuth credential through [the existing SDK authorization flow](t3-adapter.md), with `orchestration:read orchestration:operate`. Pin it to that actual service/environment. The trusted machine handling the browser must be able to reach the SDK callback. T3 readiness, native pairing/session credentials, and Provider login are not this OAuth grant. Noninteractive workers never open consent or acquire broader authority.
4. Through **supported operator configuration**, configure a dedicated isolated Provider for this agent's external Team MCP endpoint and narrow Kinmesh token. Protect its token/configuration as owner-private files (directory 0700, files 0600). Verify isolation from shared Provider homes/settings before enabling it. Kinmesh does not install MCP settings into a Provider, write shared credentials or pass secret launch arguments. `externalTeamMcpConfigured: true` is the operator's explicit configuration assertion, not an automated integration proof; the real native gate below is separate.

Create a private mode-0600 configuration, in a private directory outside source control, with absolute paths:

```json
{
  "database": "/private/kinmesh/team.sqlite",
  "pollMs": 1000,
  "bindings": [
    {
      "agentId": "00000000-0000-4000-8000-000000000001",
      "tokenFile": "/private/kinmesh/developer.json",
      "t3Endpoint": "https://private-t3.example/mcp",
      "t3AuthFile": "/private/kinmesh/t3-oauth.json",
      "isolatedProviderId": "isolated-developer",
      "externalTeamMcpConfigured": true
    }
  ]
}
```

```sh
# Ordinary supervised deployment; KINMESH_DATABASE must match inbox.json:
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm start
# Another terminal/service, using that same database:
npm run team:mcp
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:status

# Alternative: independent worker supervision (omit the variable from npm start):
npm start
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:worker
```

The strict configuration supports at most 32 unique agent bindings; an empty list is an idle worker. File descriptors reject symlinks, other-owner/public-readable or oversized configuration/agent token files; worker configuration must also be non-executable. Nonregular configuration files fail without waiting on FIFO readers/writers. The existing T3 loader enforces its credential-file and scope contract. The database, WAL and backups contain private prompts and team content. On POSIX, run the services as the same private OS owner with `umask 077`. Unsupported schema/version/model/permission settings fail closed.

### Normal startup supervision

The hub validates the owned private configuration before opening HTTP or spawning a child. The worker database and `KINMESH_DATABASE` must resolve to the **same absolute pathname relative to the hub working directory**; alternate symlink/hard-link path spellings are rejected. The existing database's canonical path/device/inode are pinned across child restarts. Replacing a live database file requires stopping the entire installation and reconciling/restoring it deliberately.

The hub forks the actual `src/inbox/main.ts` entrypoint through Node 24/tsx, with an inherited private IPC channel. It omits the hub setup/session secrets from the child environment. The child receives a validated configuration snapshot, verifies the shared database identity before/after opening, and acknowledges preparation. It waits for HTTP bind before the hub permits claims, then acknowledges its first successful loop scan. Each startup handshake has a 10-second deadline. Invalid configuration, missing acknowledgement or bind failure fails startup with exit 1 and cleans up the child. No child output or IPC payload is forwarded to logs; lifecycle diagnostics use fixed text.

`GET /health` retains the existing response shape. Without opt-in it checks the hub database; with opt-in it additionally requires a running supervised loop. It returns 503 during worker loss, startup, restart backoff or shutdown. Worker readiness says nothing about OAuth validity, Team MCP reachability, Provider isolation or native model capability. Those remain separate operational/live checks; empty bindings intentionally permit a credential-free idle worker.

An unexpected child exit allows **three replacement attempts total per hub lifetime**, after 250, 500 and 1000 ms. Becoming healthy does not reset that budget. Every replacement reloads and validates the private config and checks the pinned database identity. Initial startup errors are not retried. Exhaustion or supervision failure stops the hub with exit 1, so an outer service manager can alert/restart the installation; no healthy HTTP-only fallback silently loses an opted-in worker. The outer manager should also have its own bounded restart/alert policy.

`SIGTERM`/`SIGINT` cancel startup/backoff and stop the child before the hub closes its database. A child gets 10 seconds to abort claims/adapter work and close SQLite; the hub then uses SIGKILL and allows at most five more seconds to observe exit. Native work is not automatically interrupted. If the hub is killed, IPC disconnection makes the child stop claiming and apply its own 10-second exit deadline. Forced shutdown leaves existing durable Inbox/native leases and intents for normal reconciliation; it never resets delivery keys. A service manager should allow at least 20 seconds for hub shutdown. Config edits are not hot-reloaded into a running child; deliberate restart is required.

### Independent worker supervision

For systemd, use a dedicated unprivileged user and a service such as the following for the standalone alternative, adapting installation paths. Install the human and Team MCP units separately and leave `KINMESH_INBOX_CONFIG` absent from the human unit. For normal child supervision instead, put that variable on the human unit and omit this separate worker unit. Deployment should apply/back up migrations before enabling worker replicas.

```ini
[Unit]
Description=Kinmesh Agent Inbox
After=network.target

[Service]
Type=simple
User=kinmesh
WorkingDirectory=/opt/kinmesh
Environment=KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json
ExecStart=/usr/bin/node --import tsx /opt/kinmesh/src/inbox/main.ts
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=150
UMask=0077

[Install]
WantedBy=multi-user.target
```

`SIGTERM`/`SIGINT` stop claiming, abort in-flight adapter work and wait for cleanup before closing SQLite. Native execution is not implicitly interrupted on worker shutdown. A killed process leaves its durable leases; a successor waits for expiry and reconciles the original intent. SDK connection/discovery requests retain their bounded SDK deadlines; the worker deadline prevents a subsequent late launch. A forced supervisor kill also follows lease recovery. Fixed readiness/stopped/error lines omit credentials and team content. Startup readiness means the loop/database started, not that OAuth, Team MCP or a Provider passed a live check. `inbox:status` prints aggregate delivery counts only. An independently deployed worker does not affect the human service's `/health`; the optional child-supervision health policy is described above.

## Wake policy and causality

New committed human-authored messages route **structured mentions** to active joined agent targets. Display-name `@text` alone does nothing. Human task assignment, explicit work/reviewer handoff, request-review, rework and reviewer-requested rework route the responsible agent. A reviewer is targeted only while review is requested; work owners are targeted only while work/rework is active. Self-authored task changes, progress, claims, execution links, acceptance/cancellation and ordinary agent chat do not generate wakes.

Agent-to-agent **task responsibility transfer is allowed** through existing authorized task commands. Causality is derived from immutable task audit predecessor events, not a client-supplied chain/budget. A human action establishes a root. Agent transfers inherit it and consume a budget of four hops. `(root event, target agent)` uniqueness suppresses revisits; `(event, target agent)` uniqueness protects delivery replay. Human intervention starts a new root. Suppression affects delivery only: all messages, task decisions and source outbox facts remain retained. An agent cannot reset the budget by posting a new chat message. No automatic channel-wide subscription, text mention parsing or batching of unrelated events is provided.

Enqueue executes **inside the source message/task transaction**, including the outbox, audit and mutation receipt. Failure rolls everything back. Enqueue filters active same-team joined targets; it never grants authority. Before dispatch and publication, repositories recheck the actual credential, current persisted scopes, lifecycle and team/channel membership. Fresh dispatch requires current task work/reviewer assignment. After a persisted dispatch attempt, settlement additionally permits retained owner/reviewer responsibility as described below. A work transfer that removes that responsibility blocks old publication and retains the native reference for operator reconciliation; the new recipient has its own bounded delivery. Worker identity comes from the private token, not the configured ID alone or event/tool text.

## Scheduling and crash safety

A small SQLite scheduled loop is sufficient for this bounded policy; it is not a second T3 orchestrator or general workflow engine. One immediate transaction enforces global capacity **two** across processes and oldest outstanding event per agent. It atomically increments generation, assigns a random claim token and a **180-second** SQLite-time lease. Every freeze, correlation, defer and ACK requires the current unexpired generation/token. There are no heartbeat/PID liveness assumptions. Attempts use a **90-second** abort deadline; the unchanged T3 journal additionally applies its own 120-second single-flight lease and 60-second mutation-attempt deadline.

Retries use deterministic exponential delay 1, 2, 4… seconds, capped at 300 seconds. Attempts saturate safely and do **not** exhaust a finite retry budget during external outages. Unbound targets remain durable and consume no executions. Polling is configurable 100–30000 ms. Unresolved older work serializes that agent's later deliveries; other agents can progress within capacity.

Before a native effect, the worker freezes bounded source context, model/input, Kinmesh grant ID and T3 endpoint/environment/authority fingerprint. Prompt data includes author, team/channel, topic/task, source IDs and the memory-location **reference**. Source message text is limited to 4000 characters; task description to 2000 and criteria to five × 200. Memory files are never loaded. Team content is JSON in an ordinary user turn with a fixed untrusted-data instruction; it is never inserted into system/developer context or treated as tool authorization. T3 permission mode remains `approval-required`.

Each delivery uses stable `actor=inbox-agent:<AgentId>`, `operationKey=inbox:<DeliveryId>`. The existing T3Backend persists the native request ID and intent **before dispatch**, including PR #18 single-flight/fencing. The worker never calls native launch tools itself. A lost response returns `uncertain`; subsequent attempts explicitly reconcile the stored operation ID. If a crash occurs before that ID is saved in the Inbox, reentering the same frozen launch obtains the existing journal outcome first, then a later reconcile resumes it. A stored/provisional reference chooses authoritative read, not a new launch. This extra pass is intentional. A supported T3 v0.1.5 receipt can safely receive the same native request ID; unsupported versions fail before mutation.

Changing the T3 endpoint/OAuth authority, Kinmesh grant or configured model after freezing blocks replay instead of creating a new operation in another scope. An operator must inspect the original intent/reference and resolve its authority; do not mint a new delivery/key to hide ambiguity. Retryable transport discovery/connection failures retain work. Explicit permission/authentication/contract failures and lost assignment become `blocked`, with no publication or automatic interruption of an existing native run.

```sh
# Local trusted operator only, after resolving the precise blocker:
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:worker -- resume DELIVERY_UUID
```

Resume keeps the frozen intent/authority and native request key; it cannot bypass a revoked grant or switch authority. This CLI is local administration, not a new human/agent HTTP or MCP privilege surface.

## Results, ACK and retention

The worker reads at most four native history pages (100 items/page through the adapter). It accepts only a nonempty `assistant_message` for the exact correlated **run**, after authoritative terminal success/failure/stoppage and zero pending requests. User/tool text, another run's output, wait timeout, interrupt acknowledgement or a missing historical run cannot be substituted. Pending human input/approval stays `waiting`. Missing assistant text, incomplete history, page/cursor limits or disconnection remain waiting/uncertain/retryable; no “done” placeholder is posted. Failed/stopped runs can publish their actual assistant text with the true terminal state, not a success claim.

The persisted message contains up to 6000 characters of actual assistant text, explicit excerpt status and environment/thread/run/item/inbox/source-event references. The full result remains retrievable through the native adapter while T3 retains that history. The Inbox result association retains the delivered excerpt, exact native item/reference and correlation; Kinmesh's attributed message remains accessible after restart even if native retention later changes. This worker is not a native transcript archive.

Publication is one fenced immediate transaction: current authority/assignment checks, agent execution correlation/runtime event, optional task execution link, attributed channel/topic message with original source IDs, its outbox/receipt, result association, ACK and history snapshot. Any failure, including expiry during commit, rolls back all effects. Result messages have no mentions and cannot feed wake loops. Automatic Inbox execution links append evidence without changing task state, decision history, revision or human acceptance fields. Explicit `link-execution` commands retain their existing versioned task-command contract. Neither path **accepts a task**, advances technical review or approves a T3 request. Human acceptance remains an explicit designated-human command.

A legitimate reviewer handoff does not discard the Developer's outstanding native result. An agent with a still-valid grant, membership and retained owner/reviewer responsibility may settle its original intent after handoff or technical approval, including after human acceptance or rework. The original task wake must name that agent, and its original native dispatch attempt must already be journaled; this does not prove remote receipt, so uncertain attempts still require the existing same-key reconciliation. A frozen context alone cannot authorize a new launch after responsibility changes. Retries keep the same native intent and result attribution. Work reassignment, cancellation, revoked grants and removed membership still block publication. Recording a delayed execution link never reopens or changes the human's decision.

Never-frozen work lazily expires after seven days when its configured target is scanned. Frozen, uncertain and correlated work never expires automatically, since a native effect may already exist. Delivery/source/result/tombstone identities are retained to preserve idempotency; no online purge or historical auto-dispatch/backfill is performed. Diagnostic history is capped at the first 127 snapshots per delivery plus a reserved final ACK snapshot; current state, latest reason, attempt/generation counters, immutable source/task audit and final result remain retained. At storage thresholds, stop intake, take consistent SQLite/WAL backups and archive the whole installation under the operator's data-retention policy. There is no cross-database deduplication after restoring an older backup and no automatic total-disk quota; do not resume an old backup against live native work without reconciliation. These are explicit operational limits.

Migration `0006_perpetual_marvex.sql` adds inbox/cause/history/result tables, composite foreign keys, indexes, uniqueness and reviewed immutability triggers. Previous migrations and the T3 operation journal are unchanged. Back up DB/WAL before upgrade. Existing facts/leases remain intact; only new committed events enqueue automatically. No down migration deletes team history.

## Separate native release gate

Credential-free tests use real SQLite and worker subprocesses, with **fixture native transport** through the actual external adapter. They do not invoke a provider/model. The separate opt-in gate is:

```sh
npm run test:inbox-live
```

Missing opt-in, native approval, valid configuration, real run or actual assistant output exits 1, never skips. For an intentional minimally costly native check:

1. Use `KINMESH_TEAM_LIVE_SCENARIO=inbox npm run team:live:prepare` with explicit `KINMESH_T3_ENVIRONMENT_ID`, `KINMESH_TEAM_T3_ISOLATED_PROVIDER` and `KINMESH_T3_MODEL`, and a **new** private `/tmp/kinmesh-team-live-*` directory, as in the [Team MCP guide](team-mcp.md). Start Team MCP separately against its disposable DB. Do not reuse the fixture consumed by `test:team-live`.
2. The explicit Inbox preparation mode seeds those native profile preferences and issues the disposable `developer.json` grant with channel/task scopes plus `executions:read` and `executions:write`. The default Team-only preparation mode still lacks execution authority. Configure only the dedicated Provider for this exact endpoint/grant, with an isolated home and separately approved scoped T3 OAuth. Set a private worker config with exactly that one agent/database binding. Existing independently prepared fixtures can still use the owner APIs to configure preferences and issue grants.
3. Set `KINMESH_INBOX_LIVE=1`, `KINMESH_TEAM_LIVE_DIR` and `KINMESH_INBOX_CONFIG`, then run the gate. It starts the **ordinary worker entrypoint** as a separate process, commits a human mention, waits for ACK, independently rereads the native exact-run assistant and delivered message through Team MCP, and verifies the seeded task remains unaccepted. It writes a private sanitized correlation report in the disposable directory. Only that worker dispatches the provider.
4. The gate stops its worker and attempts native stop/archive for the known disposable reference. On uncertainty/cleanup failure, retain the fixture and inspect the private Inbox/journal/native run. Revoke disposable Kinmesh grants, stop the separately managed Team MCP, and remove the fixture only after reconciliation/cleanup. It never changes shared T3 settings or revokes a shared OAuth grant.

For aggregate `release:check`, follow the [two-context operator setup and cleanup](release-check.md). A single inherited `KINMESH_TEAM_LIVE_DIR` is insufficient; the aggregate ignores it and requires explicit independent stage configuration.

This native gate covers mention → ordinary worker → native assistant → source-linked delivery. It does **not** prove the separate Team MCP read-proof/claim/reviewer-handoff gate, native agent-to-agent task execution, browser owner acceptance, or full product E2E. Use `test:team-live` for its independent criteria and retain unmet issue acceptance gates until independently verified. Local green tests alone cannot declare native acceptance.
