# ADR 0001: Own collaboration, compose execution

Status: accepted for the issue #1 foundation; external integrations remain unimplemented.

## Decision

Apply **Reuse → Adapt → Extend → Build** in that order. Kinmesh owns human/agent identities, team authorization, channels/topics, owned tasks, handoffs, inbox/outbox delivery semantics and the collaboration UI. Unmodified T3 owns provider sessions, runs, execution, Git/worktrees and execution records. AG-UI is an interaction projection, not persistence or execution authority. Execution completion and human task acceptance are separate domain facts.

Preserve all three invariants:

1. **Independent deployment and upgrades.** Team Hub, frontend and T3 have separate release/upgrade lifecycles, even on one host. Independently install T3; record a compatible version only after external contract tests. Do not bundle its runtime or adopt changes by source patching.
2. **Stable seams.** Route every future T3 interaction through `src/adapters/t3`, using documented external OAuth MCP with the official MCP SDK, or optional documented host-local CLI. No private `@t3tools/*` imports, source edits, vendoring, T3 SQLite/event-store reads, or internal WebSocket/RPC. Issue #1 creates no adapter and makes no T3 request.
3. **Replaceability through owned contracts.** Branded IDs, task transitions, transport capabilities and execution references belong to Kinmesh. Persistence, UI, AG-UI and execution implementations must not dictate domain semantics. This does not require implementing multiple backends now.

## Module map and reuse choices

One Node 24 package is intentional: no premature microservices or empty adapter packages. `src/domain` owns runtime schemas and contracts, `src/persistence` owns SQLite/Drizzle, `src/server` owns HTTP and authentication. `scripts` owns local setup and static boundary tooling; `tests` owns reproducible local evidence. Later frontend, Team MCP, T3 and AG-UI adapters remain separate boundaries as described in README, independently deployable when introduced.

| Concern                | Reused component and rationale                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP                   | Fastify, maintained route lifecycle, injection tests and bounded bodies; no custom HTTP framework                                            |
| Runtime contracts      | Zod; validate HTTP/config, session identity and returned database rows                                                                       |
| Persistence/migrations | better-sqlite3 + Drizzle; real WAL/foreign keys/constraints, checked-in SQL, migration journal and transactional migrations                  |
| Passwords              | maintained native `@node-rs/argon2`, Argon2id with explicit OWASP baseline parameters; no custom KDF                                         |
| Sessions               | `@fastify/secure-session` authenticated encryption/cookie implementation; no handwritten token signing, session crypto or actor-header trust |
| Setup UX/rate limit    | maintained Inquirer masked prompts and Fastify rate-limit plugin                                                                             |
| Quality                | Node test runner + tsx, TypeScript and type-aware typescript-eslint; no custom test framework                                                |

Better Auth and a full identity provider were considered; their account federation, reset/email and multi-provider surface is unnecessary for a local single-owner first slice. Fastify's established session plugin plus Argon2 is the small adapter we need. This is limited local password/session authentication, not enterprise identity management. Evaluate an identity provider before adding invitations/recovery/MFA or multi-node sessions. The only custom glue maps validated input, server-verified session identity and membership to owned records. Maintenance cost includes dependency/security updates and auth regression tests; do not extend this into a custom cryptographic protocol.

The custom architecture checker fills a repository-specific policy gap: generic lint rules do not cover both private resource calls and package/lock manifests. It uses the TypeScript parser, small explicit checks and negative fixtures; it costs ongoing policy fixture maintenance and cannot replace review or a sandbox. No custom queue, scheduler, locking engine, execution harness, MCP transport or UI framework is introduced.

## Persistence and authority

The Team Hub opens only its configured Kinmesh database, migrates before listening, enables foreign keys/WAL/busy timeout, and uses an immediate SQLite transaction plus a singleton uniqueness constraint to atomically create initial owner/team/general channel. A process crash cannot publish a half-created owner. Migrations are generated through Drizzle, committed, replayed through its migrator and must never be edited after application. Back up using SQLite-supported online backup/checkpoint procedures, including WAL correctness; copying a live main file alone is not a backup strategy.

Setup requires a random one-time secret generated locally into a private file; an anonymous first request cannot claim ownership. Argon2 hashes are stored, never plaintext passwords. Session actor IDs are derived from encrypted verified cookies and rechecked against the human table; reads additionally check owner membership. Session keys/setup credentials are host configuration, not domain identities or T3 provider credentials. See security notes for stateless logout/revocation limits.

## Scenario, migration and consequences

Initial product flow: Human requests a task → Developer agent executes → Reviewer agent reviews evidence → human accepts or returns it. The future inbox/outbox needs transactions, stable idempotency keys and leased/fenced delivery or a maintained queue. No speculative implementation belongs here.

The reset main has no JavaScript application or JSON state. New runtime/tests use strict TypeScript exclusively with all requested flags. If historical prototype functionality is reintroduced, migrate one module with runtime contracts and tests, remove its JS/JSON state path, and use official SDKs for MCP. Never keep parallel implementations to claim migration.

Before a T3 upgrade: independently install the candidate in a disposable environment; run real documented OAuth/read/mutation/denial/revocation and execution lifecycle compatibility probes; record provider/browser acceptance separately; repair only the adapter; retain the previous supported version until evidence passes. These suites are future work, not a claimed CI result. Local SQLite/HTTP evidence in this foundation cannot establish T3, agent collaboration or browser E2E acceptance.
