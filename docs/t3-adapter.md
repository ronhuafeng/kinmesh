# External T3 adapter (Issue #2)

Kinmesh's execution authority remains **unmodified external T3**, independently installed/upgraded. This adapter uses official MCP SDK Streamable HTTP and OAuth only. No T3 implementation code, private package, database, WebSocket or host-CLI execution fallback is included. Tool schemas are wire-contract fixtures, not vendored runtime code. Reuse → Adapt → Extend → Build: SDK for transport/OAuth, Zod + Ajv for boundary validation, and the existing Drizzle/SQLite transaction layer for owned operation intent. The small journal fills the cross-system atomicity gap; it is not another execution harness or queue.

## No-credential external OAuth/MCP preflight

Before owner sign-in, Node 24 can check public readiness without a grant:

```sh
KINMESH_T3_ENDPOINT=https://your-t3-origin.example/mcp npm run --silent t3:preflight
```

This command reads only `KINMESH_T3_ENDPOINT`; it does not load `.env` or a credential file. Use the exact canonical HTTPS `/mcp` URL (plain HTTP is allowed only on the existing loopback allowlist). One overall 10-second deadline covers connections, discovery and response bodies. The official maintained MCP SDK discovers metadata through a same-origin, fixed-path, GET-only fetch that rejects redirects, bounds JSON to 64 KiB and never forwards cookies or authorization. Only the standard path-aware protected-resource 404 can fall back to root metadata; other discovery failures remain failures.

PASS requires unauthenticated `/mcp` to reject with HTTP 401 and a Bearer challenge, a public T3 environment descriptor with a nonempty identity and exact version `0.1.5`, and pinned issuer/resource/authorization/token/registration endpoints. It also checks S256 PKCE, authorization-response issuer support, authorization-code/public-client capabilities and advertised read/operate scopes. No scopes are requested. A 502, wrong version, missing capability or unavailable endpoint fails closed. Output is fixed PASS/FAIL text and never includes the host, environment ID or response/error bodies.

**Preflight is public network, issuer and capability readiness, not OAuth authentication or live acceptance.** It never initializes MCP, registers a client, opens consent, exchanges a token, calls a tool or runs a model. The tests use local HTTP fixtures, not an owner T3 instance. Actual owner OAuth still requires the browser or private interactive terminal flow below. Kinmesh has no supported automatic T3 session OAuth through `app.t3.codes`; an app login does not replace native external-client approval. Never paste pairing codes, one-time callback credentials or tokens into chat, GitHub or logs. Issue #2 is Closed/Completed. The [owner OAuth evidence](acceptance/t3-owner-2026-10-30.md) and [v0.1 workflow acceptance](acceptance/v01-workflow-2026-10-31.md) record their exact historical scope; public preflight and ordinary CI do not establish a new authenticated candidate-gate pass.

## Owner sign-in: local browser or remote terminal

Use Node 24 on the trusted machine that will hold Kinmesh's **own** external T3 OAuth grant. Provider account login, Team MCP bearer credentials and T3 native sessions are separate; do not copy them into this flow. Authorization itself makes no model call. The owner must approve the external client through T3's native consent page; Kinmesh cannot approve for them.

From **Settings → Environments → environment menu → Copy MCP URL**, choose an HTTPS endpoint reachable from **both** AgentEnv2 and the owner's browser. T3 Connect or an owner-managed HTTPS route can provide this. A host-local `http://127.0.0.1:3773/mcp` works for discovery from AgentEnv2, but its authorization URL points at the browser computer's own loopback if opened remotely. Manual callback paste does not solve an unreachable authorization origin. Never rewrite an issued authorization URL's host, issuer, resource or redirect to work around this; choose the correct reachable endpoint before starting. Plain HTTP is restricted to the existing loopback allowlist.

Use a fresh dedicated credential filename in an owned private directory. The CLI creates a missing directory as 0700, rejects symlinked/shared directories, and refuses **any existing destination**, including an existing private grant. It atomically publishes a new mode-0600 credential without overwrite, preserving other clients/authorities. Revocation/rotation is an explicit owner operation in T3 **Settings → Sharing & access**. No client token, registration secret or PKCE verifier is printed or stored in Kinmesh's operation journal.

### Browser on the same computer

`KINMESH_T3_AUTH_MODE` defaults to `browser`. It keeps the loopback-only callback at `http://127.0.0.1:49871/callback` and opens the authorization page without printing its URL:

```sh
npm ci
KINMESH_T3_ENDPOINT=https://your-t3-origin.example/mcp \
KINMESH_T3_AUTH_FILE=/private/kinmesh/t3-owner-new.json npm run t3:auth
```

Approve only the request just started. Select **Supervised, never Full access**, for future execution authority. A deliberately Read only grant is also supported for inspection. If required, obtain a pairing code privately from T3 **Settings → Sharing & access** and enter it only in T3's native approval page; an already signed-in browser with access-management permission can approve without a code. Do not paste pairing codes into Kinmesh, chat, GitHub or logs.

The pairing code must come from the **environment serving the chosen MCP endpoint**, not merely from the computer running the browser. For a remote Linux T3 and a Mac client, a code generated by the Mac's local T3 belongs to a different issuer and is not usable for the remote consent page. In a private owner terminal on the target machine, the installed `t3 auth pairing create --base-dir <target-data-directory> --scope orchestration:read --ttl 5m` creates a Read only code; add `--scope orchestration:operate` for Supervised consent. Set scopes explicitly: the command's defaults are broader. Copy only the value after `Token:`, not the record ID on the first line. A code is single-use; a second consent may require a new code. A `/pair#token=…` link is native client pairing, not the Kinmesh OAuth consent URL, and can consume the code intended for that consent.

### Remote owner, no local browser

In the **owner's private interactive T3 Terminal on AgentEnv2**, after independent code review, run:

```sh
KINMESH_T3_AUTH_MODE=manual \
KINMESH_T3_ENDPOINT=https://your-t3-origin.example/mcp \
KINMESH_T3_AUTH_FILE=/private/kinmesh/t3-owner-new.json npm run t3:auth
```

1. Use an unrecorded trusted terminal with interactive stdin/stdout/stderr. Do not run this command through an agent tool, CI, a terminal recorder, `tee`, redirected output or a shared session. Manual mode rejects non-TTY operation and writes its sensitive URL directly to the controlling `/dev/tty`, rather than console/log output. A terminal's own scrollback/recording policy remains the owner's responsibility.
2. Open the one-time URL shown **only there** in the owner's browser. Confirm the expected T3 environment, **Kinmesh external T3 adapter** client and localhost return address. Approve in T3's page using the existing Sharing & access session/pairing mechanism. Choose **Supervised, never Full access**. No agent/CLI approval or copied client session substitutes for this action.
3. After approval, the browser attempts its own `127.0.0.1:49871/callback` and may show a connection error. Immediately copy the **complete final URL from the address bar** into the terminal's hidden prompt and press Enter once. No tunnel or publicly reachable callback listener is needed. Manual mode starts no HTTP listener. The prompt never echoes the URL and disables the password prompt's reveal shortcut. Do not paste it into chat, GitHub, a model prompt or shell command.
4. T3 v0.1.5 codes expire **60 seconds after issuance**. Paste promptly; do not wait for another AI turn. The complete flow has a three-minute deadline. Invalid, expired, refused or timed-out attempts fail closed; restart a fresh request with fresh SDK state/verifier. Do not reuse an old final URL. A failed attempt may leave an unapproved registration or approved client in Sharing & access; inspect/revoke that dedicated client there as needed.

Both modes validate the exact callback scheme/host/port/path, one each of `state`, `code` and `iss`, matching random state and pinned issuer, and reject duplicates, OAuth errors, fragments, URL credentials, extra parameters, controls and oversized/malformed input. Browser callbacks are single-use and require the exact loopback Host. The official maintained MCP SDK owns discovery, dynamic client registration, S256 PKCE and exchange with the original verifier. Auth discovery requires the pinned T3 v0.1.5 issuer/resource/endpoints and never follows redirects or contacts another origin. Rejected exchanges are not retried with an expired code. No arbitrary callback host or private T3 interface is introduced.

### No-model SDK smoke after owner approval

Once the CLI has actually saved the newly approved credential, use the **same endpoint and filename**:

```sh
KINMESH_T3_ENDPOINT=https://your-t3-origin.example/mcp \
KINMESH_T3_AUTH_FILE=/private/kinmesh/t3-owner-new.json npm run t3:smoke
```

This uses the existing official-SDK adapter for MCP initialization, `tools/list`, `t3_environment_read` and `orchestrator_capabilities` only, validates the pinned environment/version and advertised schemas, then closes the connection. It never launches, sends, waits on, interrupts or archives a thread, invokes a Provider/model, or writes the operation journal. Output is fixed PASS/FAIL text without private environment/provider details.

A successful read probe verifies current read access. It separately reports whether the **returned token scope** includes `orchestration:operate`; no mutation is exercised, so it does not prove operate behavior or automatic Inbox wake. For an operate grant, the capability ceiling must be `approval-required` (Supervised), otherwise the smoke fails. A Read only result is valid inspection authority but cannot enable the Inbox executor. Tool visibility alone never proves privilege. Fixture/PTY tests are not an actual owner-approved browser flow or native E2E pass.

Credential loading rejects symlinks, nonregular/oversized/other-owner/shared/executable files, wrong endpoints, missing read scope and broader settings/control scopes. Private files contain sensitive grants; protect the directory and backups. Noninteractive adapter use never opens consent or silently changes authorities. Expired/revoked grants require another explicit owner sign-in; there is no refresh-token emulation. Kinmesh account sessions and T3 OAuth remain separate. Model/live acceptance gates require their own explicit authorization and budget; do not run them merely to check OAuth.

## Contract and supported surface

`src/domain/execution.ts` owns `ExecutionBackend`, explicit project/scratch targets, operation intent, stable environment/thread/optional-run references, normalized observations and discriminated dispatch/wait/stop results. SDK/native types remain inside `src/adapters/t3`. The adapter is a library plus smoke/auth CLIs. The separately deployed [Agent Inbox worker](agent-inbox.md) supplies bounded collaboration wake policy; there is no unauthenticated execution API.

| Domain operation | External T3 tool / semantics                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect          | `t3_environment_read`, `orchestrator_capabilities`, SDK `tools/list`; pin primary identity and v0.1.5, resolve optional linked target separately                 |
| Launch           | `t3_thread_launch`, explicit project ID **or** `scratch: true`, advertised provider instance/driver/model, explicit permission mode, persisted `clientRequestId` |
| Read/history     | `t3_thread_read`, nested `thread`, `recentRuns`, `items`, `nextPosition`, `hasMore`; bounded message pages, explicit item truncation flags                       |
| Follow-up        | `t3_thread_send`, queue mode and persisted operation key; no silent steer/restart                                                                                |
| Wait             | `t3_thread_wait`, 1–20000 ms server wait; `timedOut` is a timeout, not successful completion; then authoritative read                                            |
| Stop             | `t3_thread_interrupt` for the requested run; acknowledgement alone is not terminal; authoritative read determines requested versus terminal                      |
| Reconcile        | persisted reference → read; otherwise replay only the same persisted command/key on the tested idempotent version, then read                                     |

Linked `environmentId` is passed as a routing target, **never** as a substitute for project/scratch selection. Primary and linked identities/version must match configuration. SDK reconnections revalidate primary identity/version before further tools. Reconnection does not retry mutations invisibly.

Read selects the requested run from `recentRuns`, rather than borrowing thread/latest status. `completed` maps to execution `succeeded`; interrupted/cancelled/rolled-back are terminal `stopped`; `waiting` remains nonterminal. Human acceptance is always `not-evaluated`. If a requested historical run lies outside the native 50-run window, return `uncertain`, not another run's success. Message pagination is exposed; text truncation is explicit. Token streaming and AG-UI projection are not implemented.

All invoked inputs/outputs are validated against installed advertised JSON schemas, with additional Kinmesh runtime invariants for target/model/version/identity and nested response projection. T3 v0.1.5 omits `outputSchema` on `t3_thread_organize`; the live cleanup-only archive call validates the documented dispatch `sequence` result instead. This cleanup helper is not an advertised core execution operation. The SDK also validates native tool outputs where supplied.

## Durable operations and recovery

Kinmesh's own `execution_operations` table records `(endpoint + environment scope, trusted actor, caller operationKey)`, input fingerprint, OAuth authority fingerprint, random stable native request ID, tool/payload, phase and provisional/known reference. The DB may contain sensitive prompts; protect and back it up as team data. The authority fingerprint is a hash, not a bearer token. Callers must supply an operation key from a stable business operation and derive the actor from their authenticated context; this CLI's local owner is trusted. Do not take either as permission from an unauthenticated request.

An immediate transaction persists intent **before** dispatch. A single SQLite compare/update claims the prepared row with a durable generation, random claim token and 120-second lease. Initial dispatch and explicit reconciliation share this claim across connections/processes. A second caller sees in-flight/uncertain rather than creating another command. Normal dispatch claims only prepared rows; only explicit reconciliation may recover uncertain or expired dispatching rows. Input changes under the same key are conflicts. A genuinely different operation needs a new key; a retry does not. Keys are actor/endpoint/environment scoped and fingerprints additionally bind tool/target/payload/credential authority.

| Phase/outcome                                                                   | Safe next action                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `prepared`                                                                      | Claim and dispatch persisted request ID                                                                |
| `dispatching`, crash, lost reply, timeout or in-flight cancellation             | Return discriminated `uncertain` with operation ID; explicitly reconcile, never invent a new retry key |
| Valid reply but read fails                                                      | Keep provisional reference; reconcile by authoritative read without a mutation replay                  |
| Valid reply + matching authoritative run/thread                                 | Atomically mark `known`; duplicate caller gets the stored reference                                    |
| Explicit native `capability_denied` or HTTP auth rejection before a valid reply | Persist rejection and fail; generic network/tool text is not denial evidence                           |
| Unsupported version/missing `clientRequestId`                                   | Fail before mutation; do not fall back to titles/PIDs/search heuristics                                |
| Reauthorization with a different authority fingerprint                          | Conflict, not a blind replay under another principal; owner must resolve existing intent/reference     |

Every journal write checks dispatching phase, generation, claim token and unexpired lease in the same SQL statement, using SQLite time. Expired or superseded owners cannot save a provisional reference, publish known/rejected, or downgrade a newer outcome; they return uncertain/in-flight. Known and rejected rows are terminal for journal mutations. Claims have no heartbeat or renewal: a crashed process leaves an active lease until expiry, after which explicit reconciliation can acquire a new generation using the **unchanged** native request ID and payload/authority fingerprint. A provisional reference always selects read-only reconciliation.

SDK mutation requests time out after 30 seconds; an adapter dispatch/recovery attempt also receives a 60-second abort deadline, shorter than the 120-second lease. Reconnect checks cancellation before sending a tool call. Leases use the shared SQLite host clock; keep it synchronized and avoid clock jumps during recovery. Process suspension, lost replies and remote execution continuing after client cancellation remain distributed-system uncertainties: this lease guarantees a single unexpired local claim and fenced journal writes, not remote exactly-once effects. Native same-key idempotency remains required after lease expiry.

Before applying the additive lease migration, stop **all old adapter processes** using this database; mixed old/new writers are unsupported because old binaries lack fencing. Back up the database, migrate with the normal startup, then restart only upgraded adapters. Legacy dispatching rows receive generation 0, no claim token and expiry 0, making them recoverable by explicit reconciliation. Migration preserves existing request IDs, payloads, fingerprints and references. Do not delete the journal or invent a new business key to recover an expired claim.

An aborted client wait does **not** stop T3 work. Use an explicit authorized stop operation. Mutation cancellation after dispatch remains uncertain because the remote command may have committed. Per-fetch deadlines and SDK request timeouts bound transport requests; the native wait timeout remains a distinct domain result.

Reconciliation may safely replay exactly the old command/key if no reference was received. T3's native idempotency is the cross-system deduplication authority. The local claim lease is only Kinmesh concurrency control; no PID/title marker or JSON-file lock stands in for native idempotency. Native permission/session/runtime-mode ceilings are never bypassed. T3 v0.1.5 refuses a send to an archived thread before replay (`thread_not_sendable`); unresolved sends remain uncertain until an owner deliberately unarchives that disposable thread and reconciles the **same** key. Do not switch to CLI or synthesize a new launch. Other native orchestration errors also fail closed as incompatible/uncertain rather than pretending to be permission evidence or completion.

## CI verification and accepted native evidence

Push/pull-request CI is the ongoing quality gate. It runs strict TypeScript, type-aware lint, formatting, architecture and migration checks, Node/SQLite/worker/official-SDK fixture tests, a production dependency audit and real Chromium browser tests. Routine CI has **no T3 OAuth credentials**, makes no paid Provider/model calls and does not represent mocked transport as live native acceptance. A separate, explicitly dispatched [complete native collaboration gate](ci.md) creates its own disposable T3/OAuth state and uses Environment Secrets for real Codex/Grok calls.

```sh
npm ci
npm run check          # all first-party types, type-aware lint, local tests, architecture
npm run format:check
npm run build          # emitted JS is ignored build output; stages committed migrations
npm audit --omit=dev
npm run test:contract  # explicitly MOCK/AUTH UNIT plus captured schemas; not a live pass
npm run test:live      # requires configured grants + reachable real T3; exits 1 when missing
npm run release:check  # candidate release is rejected unless authenticated live gate passes
```

The existing `test:live`, `test:team-live`, `test:inbox-live` and dedicated owner-runner `release:check` path remain available for configured remote T3 deployments. The unattended `test:collaboration-live` harness and its manual GitHub workflow are blocked with `approval-required`: automated native OAuth consent and pending-tool approval cannot substitute for the owner personally consenting and approving. The workflow stops before checkout or secret-bearing execution; see [CI safety limits](ci.md). Routine CI and the existing owner-runner gate remain separate. Previously witnessed owner OAuth, native executions and compatibility scenarios are preserved in [the T3 owner report](acceptance/t3-owner-2026-10-30.md) and [v0.1 workflow report](acceptance/v01-workflow-2026-10-31.md), with exact tested revisions and limits. A future T3 release or changed MCP contract still calls for targeted real compatibility verification before adoption. Operator commands `t3:preflight`, `t3:auth` and `t3:smoke` remain available to establish and diagnose a real connection.

The aggregate now requires the [isolated release setup](release-check.md): two separately prepared disposable Team contexts and a separate SDK scratch directory, explicit per-stage grants/providers and a private release manifest. All local prerequisites and read-only native readiness probes run before any model-capable stage starts. Direct `test:live`, `test:team-live` and `test:inbox-live` retain their independent environment contracts.

Normal push/PR CI has **no execution credentials**, runs local/contract/build checks only, and does not label live integration green. A separate owner-dispatched workflow uses a dedicated `kinmesh-t3-acceptance` self-hosted runner with private configuration outside the checkout. Review code before running it; never attach that runner/authority to automatic untrusted PR events. The workflow is implemented, but no self-hosted GitHub live run is claimed here.

The live gate spends two model turns on disposable scratch threads: exact no-tools nonce completion, then a follow-up requesting at most 200 characters, interrupted while active. The character limit is a prompt instruction, not a token or cost cap. If the short follow-up finishes before the active observation or interrupt, the gate fails rather than claiming interruption; do not automatically rerun it. It also loses an actual idle-launch reply, closes SDK/reopens the Kinmesh DB, replays the same native key and proves the original thread identity. A separate real read-only grant must return native `capability_denied` for a valid mutation. This can be structured content or JSON text in an `isError: true` MCP envelope; plain error prose, unrelated errors and transport failures do not establish denial. Cleanup archives its own threads; cleanup failure makes the gate fail. Output contains fixed pass/fail labels, never model text or credentials. Its private report is evidence only with that invocation's successful exit, not a reusable stale credential/CI pass. The report does not infer whether the OAuth approval used a human browser.

On macOS, use Node 24 and a canonical temporary-directory path for credential fixtures (`/var` can resolve through `/private/var`). Process supervision fixtures use macOS `ps` for their own child processes and BSD `script` for the mock private terminal; Linux keeps its `/proc` and util-linux paths. These fixtures do not exercise an owner grant.

The `@fastify/static` dependency currently requires glob 13, which has no patched release for GHSA-3g3m-2fjr-6pw4. The scoped npm override selects glob 14.0.3 with minimatch 11.0.3, covering that advisory and GHSA-g3hv-75wg-m249 without downgrading Fastify's static plugin. Node 24 is supported by those dependencies; actual asset-serving/browser tests accompany the override. Remove the override when the plugin supports a patched dependency itself. Audit against a registry with the security API, for example `npm audit --omit=dev --registry=https://registry.npmjs.org`; some mirrors return `NOT_IMPLEMENTED`.

### Compatibility matrix

| Boundary                                                                                                      | Tested status                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Official unchanged T3 `0.1.5`, public HTTPS Streamable HTTP OAuth                                             | Actual SDK registration/PKCE/headless native pairing-code approval, authenticated tool calls witnessed in Runner                           |
| `clientRequestId` launch/send/interrupt                                                                       | Advertised by installed schemas and reviewed at upstream tag; launch same-key replay after real lost reply/reopen witnessed                |
| Provider `codex`, model `gpt-6.1-sol`, Supervised grant                                                       | Actual exact nonce completion, send, active interruption and terminal reconciliation witnessed                                             |
| Scratch selection, project selection and linked environment routing                                           | Owner scratch model lifecycle live; isolated project/linked idle-thread selection, identities and provider/model binding live (no model)   |
| Nested read, completed wait, native denial                                                                    | Actual versioned shapes captured and sanitized; live calls witnessed                                                                       |
| Waiting, timeout, `interrupt_requested` vs terminal, schema/transport errors, cancellation, credential change | Mock/contract tests derived from captured schemas; not every branch witnessed live                                                         |
| Browser OAuth consent UX                                                                                      | Owner completed Read only and Supervised browser flows on Mac; both official remote MCP smoke probes passed (2026-10-30)                   |
| T3 server process restart / upgrade                                                                           | Isolated 0.1.4 → 0.1.5 identity preservation, stopped-peer failure, real restart/read and same-key native replay live; real 0.1.4 rejected |

Actual Kinmesh evidence is separate from historical Runner G0–G5. It does not establish full team task acceptance or multi-user authorization. [Owner acceptance evidence](acceptance/t3-owner-2026-10-30.md) separates the Mac/remote owner OAuth path from isolated compatibility probes and records their limits. A dedicated authenticated CI runner and broader Team MCP/Inbox acceptance remain separate work. Adopt a new T3 version only after reviewing its public versioned schemas and running compatibility + authenticated live gates against that independently installed version; repair the adapter, never T3 internals.

### Witnessed Runner verification (2026-10-30)

Final `npm ci` and `npm run release:check` succeeded with 45 local tests, strict typecheck, type-aware lint, architecture, formatting, build and zero runtime audit vulnerabilities. The authenticated live gate passed all nine fixed checks: launch, persisted-key reuse, exact completion, active follow-up, interrupt acknowledgement, terminal interrupt reconciliation, lost-reply uncertainty, database-reopen/same-key reconciliation and native read-only denial. Both test grants were subsequently revoked; each old bearer returned explicit HTTP 401 with a Bearer challenge. Disposable threads were archived; T3 and its tunnel were left running. The browser OAuth CLI and GitHub manual live workflow were not exercised. No provider response text or credential material is retained in this report.
