# Kinmesh

A persistent collaboration workspace for humans and AI agents. **Composition over Modification: Reuse → Adapt → Extend → Build.** This issue #1 foundation implements Kinmesh-owned identity, one-time onboarding, an authenticated Team Hub and transactional storage. The stacked Issue #2 adapter adds external execution; a collaboration UI is not yet implemented.

## Run locally (Node 24)

```sh
npm ci
npm run setup        # creates a random .env with mode 0600; refuses overwrite
npm start            # loopback 127.0.0.1:3000; keep this terminal running
# In another terminal:
npm run onboard     # masked owner-password prompt; creates owner + team + general channel
```

No T3 install, external credentials, or provider calls are needed. Do not expose the loopback listener directly. Keep `.env`, the database, WAL and backups private. `.env.example` documents configuration; it contains no working credentials. The service migrates its own SQLite database automatically before listening. Keep `drizzle/` beside `src/` when deploying; use `npm ci` including the TypeScript runner, rather than pruning development dependencies.

`GET /health` returns `200 {"status":"ok","component":"kinmesh-team-hub"}` only when its database can be queried; database failure returns 503. This is **not T3 health or live-agent readiness**.

### HTTP contract

All bodies are JSON; errors omit validation input and internal diagnostics. Only health, secret-protected first-run setup, and password login are public. Other `/api/` routes require an encrypted, verified session and an existing account. No actor/member header grants access; those headers are rejected.

| Method/path        | Authorization and behavior                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`      | Public database readiness, no identities or secrets                                                                                                |
| `POST /api/setup`  | One-time `Authorization: Bearer <setup-secret>` from private `.env`; `{username,password,teamName}`; 201 once, 409 after setup, 401 without secret |
| `POST /api/login`  | `{username,password}`; verified Argon2id password; HttpOnly, SameSite=Strict encrypted cookie, one-hour lifetime                                   |
| `GET /api/me`      | Session-derived human identity; never password hash                                                                                                |
| `GET /api/team`    | Session-derived owner membership; its team and channels only                                                                                       |
| `POST /api/logout` | Authenticated cookie deletion                                                                                                                      |

Use the CLI for setup so credentials never enter command arguments or shell history. To exercise login/reads without a UI, a local client can POST credentials from a protected input file and retain cookies in a private cookie jar. Never commit or log either. Usernames: lowercase letters/digits/underscore/hyphen, 3–64 characters. Passwords: 15–128 characters. Setup creates no login session; explicitly log in afterward. Setup/login have per-IP limits (five attempts/minute); the service has a general request limit. Incorrect/unknown accounts return the same login error. Mutating browser requests with an Origin must match configured `KINMESH_ORIGIN`; cookies are Secure for HTTPS origins. Use a same-origin HTTPS reverse proxy for remote access; proxy trust and distributed rate limiting are deliberately not enabled.

## Ownership and module map

See [ADR 0001](docs/adr/0001-composition-and-foundation.md) and [security notes](docs/security.md).

| Module                                     | Responsibility                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain`                               | Kinmesh-owned branded identity contracts, task/transition/execution-reference contracts; runtime schemas; no infrastructure imports |
| `src/persistence`                          | Kinmesh-only SQLite WAL, Drizzle schema/migrations and transactional bootstrap                                                      |
| `src/server`                               | Validated configuration, Fastify HTTP, encrypted session and membership authorization                                               |
| `scripts`                                  | Local secret creation/onboarding; deterministic static architecture validation                                                      |
| `tests`                                    | Type-checked unit/integration/HTTP/restart/crash-recovery/negative architecture fixtures                                            |
| `src/adapters/t3`                          | Issue #2: external OAuth MCP through the official SDK; durable execution/recovery boundary                                          |
| Future frontend / Team MCP / AG-UI adapter | Separate owned boundaries, introduced only by their issues                                                                          |

One package avoids speculative services, workers and empty adapters while preserving these logical boundaries. Kinmesh owns persistent humans/agents, teams/channels, tasks, inbox/delivery and the collaboration UI. **Only the human/team/channel foundation is persisted today.** T3 owns provider sessions, runs, execution, Git/worktrees and execution records. T3 is independently installed and upgraded; this repository neither embeds nor modifies it.

The three invariants are independent deployment/upgrade lifecycles, stable external integration seams, and replaceable components behind Kinmesh-owned contracts. Allowed T3 seams are documented external OAuth MCP and, if appropriate, its official host-local CLI, exclusively through the adapter. Private packages, source patches/vendoring, direct database/event-store reads and private WebSocket/RPC contracts are forbidden. Never treat AG-UI as a team database or fabricate execution events.

## Validate and change

```sh
npm ci
npm run typecheck       # all application, tests, scripts and TS configuration
npm run lint            # type-aware strict rules; unsafe suppressions/assertions rejected
npm test                # real local SQLite + HTTP and process tests; no provider credentials
npm run architecture    # source imports/resource calls AND manifests/lockfile
npm audit --omit=dev     # runtime dependency audit; not live acceptance
# After an intentional Drizzle schema change:
npm run db:generate     # review and commit generated SQL + metadata; never edit an applied migration
```

`npm run check` combines typecheck, lint, tests and architecture. Push/PR CI runs each explicitly on Node 24 using `npm ci`. The architecture guard rejects private T3 package imports (including dynamic imports), manifests/npm aliases/lock entries, obvious private file reads/writes, WebSocket construction, CLI installation changes, vendored paths, JavaScript runtime files and domain→infrastructure imports. Negative tests prove these detections. It is a static guard, **not a sandbox or complete data-flow analyzer**; obfuscated/computed access and external modifications still require review. The separate adapter contract and authenticated live gates are described below; credential-free CI does not claim live acceptance.

## v0.1 acceptance scenario and remaining work

Target: **Human → Developer Agent → Reviewer Agent → human acceptance**. A human creates a task in a channel; the Developer executes through the T3 adapter, the Reviewer independently checks evidence, and the human accepts or returns it. A completed execution never means an accepted task. Persist task ownership, handoffs and idempotent inbox/outbox events before implementing autonomous dispatch. This scenario is documented, **not runnable end to end** in this PR.

Remaining integrations: owner browser OAuth and deployment lifecycle acceptance (see Issue #2 adapter guide), persistent agent credentials and richer membership/auth lifecycle (#3), channels/topics/tasks/inbox/outbox, React/shadcn/CopilotKit UI and verified AG-UI projections, execution evidence, browser/provider E2E, packaging and operational acceptance. No mocks stand in for T3. Session revocation/password recovery/invitations/MFA and multi-node operation are not implemented. See security notes before deployment.

The reset base contains only README/.gitignore; there is no retained JS/JSON-state implementation to migrate. All new first-party code/tests are strict TypeScript. Future imported prototype modules must be migrated in their responsible issue, without parallel JS implementations or handwritten MCP/locking. Adopt T3 upgrades separately, run real external compatibility tests before pin changes, and repair adapters rather than T3 internals.

## External T3 adapter (Issue #2, stacked on the foundation)

The strict TypeScript `ExecutionBackend` and `src/adapters/t3` now provide authenticated official-SDK external launch/read/send/wait/stop/reconciliation. Kinmesh persists operation intent and stable native retry keys in its own transactional DB before effects; uncertain replies never trigger unkeyed relaunch. This adds no team execution HTTP endpoint and never replaces/modifies T3.

See [secure OAuth setup, compatibility matrix and recovery rules](docs/t3-adapter.md). `npm run t3:auth` opens local browser approval without printing a URL/token. `npm run test:contract` runs explicitly labeled mock/schema tests; `npm run test:live` requires real configured OAuth grants and fails when absent. `npm run release:check` cannot pass without that authenticated live gate. Normal PR CI is credential-free and does not claim T3 E2E.

This adapter implements part of the documented future flow; task dispatch, richer agent identities, UI/AG-UI, human acceptance and production lifecycle acceptance remain future work. The linked adapter guide describes the supported surface and remaining deployment gates.
