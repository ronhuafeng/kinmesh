# Working on Kinmesh

Development guidelines for people and agents. Kinmesh is a persistent workspace where
people and AI agents work together: a Fastify/SQLite team hub (`src/`), the React
workspace (`web/`), and T3 Code as the agents' runtime. Start with
[README.md](README.md).

| Code              | Responsibility                                              |
| ----------------- | ----------------------------------------------------------- |
| `src/domain`      | Strict TypeScript/Zod contracts and pure policy             |
| `src/persistence` | Drizzle/SQLite state, migrations, audit, receipts, outbox   |
| `src/server`      | Fastify HTTP, principals, authorization, worker supervision |
| `src/inbox`       | The Inbox worker                                            |
| `src/team-mcp`    | The standalone Team MCP service                             |
| `src/adapters/t3` | The T3 adapter (official MCP SDK only)                      |
| `src/workspace`   | Workspace snapshot and AG-UI contracts                      |
| `web`             | The React workspace                                         |

Reuse → Adapt → Extend → Build: prefer maintained libraries and supported external
interfaces. Never import, patch or read T3 internals.

## UI

The **Principles** in [docs/design/DESIGN.md](docs/design/DESIGN.md) are mandatory for
any change under `web/`; read them first. New UI must match the existing style and be
beautiful, reuse the shared elements instead of adding variants, and be checked and
measured in a real browser. In short: remove rather than explain; no folds, drawers,
annotation text or anything that repeats the navigation; alignment is measured, not
eyeballed.

## Checks

Locally, check what you changed and leave the full suites to CI:

```sh
npm run typecheck
npx eslint <changed files>
npx vite build          # UI changes
npm run db:generate     # only after an intentional schema change; review the SQL, never edit applied migrations
```

Update the tests a change affects. CI's `foundation` and `chromium` jobs run every
suite on each pull request. The live and native gates use real T3 and models and are
run deliberately by an operator, never by routine CI; see
[operations](docs/operations.md#live-and-native-gates).

## Merging

Pull requests merge by rebase only, after both required checks pass.

## Documentation

1. The repository keeps only what stays true for the current system: design guidelines
   ([docs/design/DESIGN.md](docs/design/DESIGN.md)), development guidelines (this
   file), and current reference ([collaboration](docs/collaboration.md),
   [T3 and Team MCP](docs/t3.md), [operations](docs/operations.md),
   [security](docs/security.md)).
2. Anything produced while developing a feature — design briefs, ADRs, plans,
   mock-ups and reference images, acceptance or evidence reports, migration or
   issue-history notes — goes in GitHub issues, never in the repository. Once a
   feature ships, its design and ADR left in the repository become maintenance debt.
3. Each fact has one owning document (below). A change in behaviour updates the owning
   document in the same change; everywhere else links to it and never restates it.
4. Docs describe the present: no "previously", no issue or PR numbers, no dated
   evidence.

| Topic                                                                         | Owner                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------- |
| UI look, behaviour and wording                                                | [docs/design/DESIGN.md](docs/design/DESIGN.md) |
| Domain model, HTTP API, state rules, idempotency, pagination, Inbox semantics | [docs/collaboration.md](docs/collaboration.md) |
| T3 adapter, supported T3, owner sign-in, Team MCP                             | [docs/t3.md](docs/t3.md)                       |
| Running, worker supervision, live and native gates, release check, CI         | [docs/operations.md](docs/operations.md)       |
| Security rules and limits                                                     | [docs/security.md](docs/security.md)           |
| Quick start                                                                   | [README.md](README.md)                         |
| Development guidelines                                                        | AGENTS.md                                      |
