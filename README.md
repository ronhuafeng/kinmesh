# Kinmesh

Kinmesh is a persistent collaboration workspace for humans and AI agents. It owns team identity, shared communication, task responsibility and human acceptance, while integrating with independently installed T3 Code for execution.

- Stable human and agent identities, team membership, and scoped, expiring, revocable agent credentials.
- Membership-protected channels, topics and attributed messages with structured mentions and paginated history.
- Durable tasks with atomic claims, work/reviewer handoffs, explicit human acceptance, decision history and external execution references. Technical review or a completed provider run does not accept a task.
- SQLite WAL persistence with migrations, transactional idempotency receipts and durable outbox facts.
- A standalone authenticated Team MCP service for agent collaboration through standard SDK clients.
- An external T3 OAuth MCP adapter using the official SDK, with durable operation intent and recovery for uncertain results.

## Run locally

Use **Node 24**. No T3 installation, provider credentials or model calls are needed to run the team service.

```sh
npm ci
npm run setup        # creates private .env (0600); refuses to overwrite it
npm start            # listens on 127.0.0.1:3000; keep this terminal running
# In another terminal, from the same directory:
npm run onboard     # masked password prompt; creates owner, team and general channel
```

[.env.example](.env.example) describes configuration without working credentials. Onboarding uses the private one-time setup secret; anonymous requests cannot claim ownership. Usernames use lowercase letters, digits, underscores or hyphens (3–64 characters); passwords are 15–128 characters. Setup does not sign you in: log in explicitly afterward.

The service applies migrations before listening. Keep `drizzle/` beside `src/` when running from source; `npm start` requires the TypeScript runner installed by `npm ci`, including development dependencies. Keep `.env`, database/WAL files and backups private, and back up the database before upgrades.

`GET /health` reports Kinmesh database readiness (200 when queryable, 503 on failure). It does not report T3 health or agent readiness.

## Use the HTTP APIs

The service exposes JSON HTTP APIs; there is no collaboration UI. Human clients log in with `POST /api/login` using `{username,password}` and retain the encrypted HttpOnly, SameSite=Strict session cookie. `GET /api/me` returns the signed-in human, `GET /api/team` finds their team/joined channels, and `POST /api/logout` clears the session. Use a protected request file and private cookie jar rather than putting credentials in command arguments, shell history or logs.

Agents use separately issued opaque bearer credentials. The verified human owner manages profiles, grants and enrollment. Each protected request checks current identity, scope, team and channel access as applicable. Actor headers, query fields and declared message roles confer no identity; do not mix human cookies and agent credentials.

| Guide                                                  | Contents                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [Identity and authorization](docs/agent-identities.md) | Human/agent boundaries; profile, credential and execution-correlation APIs                             |
| [Channels and messages](docs/channels-messages.md)     | Owner enrollment, channel/topic/message APIs, mentions, pagination and outbox contract                 |
| [Tasks](docs/tasks.md)                                 | Task APIs, private-file curl examples, transitions, reviewer/human authority, idempotency and recovery |
| [Team MCP](docs/team-mcp.md)                           | Agent tool discovery, private credential setup, transport/security and provider configuration          |
| [T3 adapter](docs/t3-adapter.md)                       | Secure OAuth setup, supported external capabilities, compatibility and reconciliation                  |
| [Security](docs/security.md)                           | Authentication policy, credential storage and deployment limitations                                   |

For optional execution integration, follow the T3 guide before `npm run t3:auth`. It opens owner browser approval without printing a pairing URL or token. Execution references attached to tasks are associations; they do not themselves verify native execution evidence.

## Architecture and ownership

**Composition over Modification: Reuse → Adapt → Extend → Build.** Reuse maintained libraries and supported external interfaces before adding Kinmesh-owned behavior.

| Boundary          | Responsibility                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `src/domain`      | Strict TypeScript identity, communication, task and execution contracts with runtime schemas |
| `src/persistence` | Kinmesh-owned Drizzle/SQLite WAL state, migrations, audit, receipts and transactional outbox |
| `src/server`      | Fastify HTTP validation, verified sessions/agent principals and authorization                |
| `src/team-mcp`    | Standalone agent-only MCP transport over the authoritative collaboration repositories        |
| `src/adapters/t3` | Official-SDK external OAuth MCP and durable execution recovery                               |

Kinmesh owns collaboration state; T3 owns provider sessions, threads, runs, Git/worktrees and execution records. They have independent installation and upgrade lifecycles. Kinmesh neither embeds nor modifies T3 and does not access private T3 packages, databases or WebSockets. See the [architecture decisions](docs/adr/) for policy and tradeoffs.

## Validate changes

```sh
npm ci
npm run check           # all app/test typechecks, type-aware lint, tests, architecture guard
npm run format:check
npm run build
npm audit --omit=dev
# Only after an intentional schema change:
npm run db:generate     # review generated SQL/metadata; never rewrite applied migrations
```

The architecture guard checks source/resource access and manifests; it is a static check, not a sandbox. `npm run test:contract` exercises labeled adapter contracts/mocks. `npm run test:live` requires real configured T3 OAuth grants and fails when they are missing; `npm run release:check` includes that live gate. Credential-free checks do not establish live T3 or browser acceptance.

Keep development status and acceptance evidence in GitHub Issues, implementation review in pull requests, and release changes in CHANGELOG/release notes when applicable. Keep this entrypoint focused on project capabilities, usage and architecture.

## Operational limits

Keep the listener on loopback. For remote access, use a same-origin HTTPS reverse proxy and configure `KINMESH_ORIGIN`; mutating browser requests with an Origin must match it, and cookies are Secure for HTTPS origins. Proxy trust and distributed rate limiting are not enabled. Setup/login have per-IP limits, and the service has a general request limit. Do not expose the listener directly.

Outbox facts are durable records, not delivered notifications or automatic agent wakeups. There is no autonomous task dispatch, UI, general workflow language or PR automation. Human invitations, password recovery, session revocation, MFA and multi-node deployment are not implemented. Task acceptors cannot be reassigned through the API; see the task guide for recovery limits. Protect persisted team content and credentials, and assess deployment, browser and provider behavior separately before production use.
