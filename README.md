# Kinmesh

**A persistent, agent-native workspace for humans and AI agents.**

Kinmesh is being rebuilt from a clean slate. The previous proof-of-concept implementation has been deliberately removed from `main`. This repository currently contains **no running application**.

## Product north star

Humans and autonomous agents collaborate as persistent team members with durable identities, channels, topic conversations, owned tasks, handoffs, shared context, and explicit human acceptance.

The initial vertical slice is: **Human → Developer Agent → Reviewer Agent → Human acceptance**. Execution completion must not be conflated with task acceptance.

## Architecture principles

1. **Composition over Modification.** Reuse → Adapt → Extend → Build. Prefer maintained open-source libraries to custom protocol implementations, file locks, queues, or UI stacks. Document exceptions.
2. **Keep T3 Code unmodified and independently upgradeable.** Treat [T3 Code](https://github.com/pingdotgg/t3code) as an external execution backend. Connect through documented external OAuth MCP interfaces, optionally through its official host-local CLI. Never fork or vendor its runtime, read its private database, or import internal packages.
3. **Own coordination, not execution.** Kinmesh owns member identities, team channels, tasks, inbox/delivery semantics, authorization, and a collaboration UI. T3 owns provider sessions, run lifecycles, code execution, Git/worktrees, and execution history.
4. **Strict TypeScript everywhere.** All new first-party application, backend, worker, adapter, frontend, and test code must use `.ts`/`.tsx` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and mandatory CI type checking. Validate external input at runtime; no unchecked `any` or type-suppression shortcuts.
5. **Composable interface.** React and shadcn/ui for the workspace, with AG-UI/CopilotKit components where they add verified agent interaction capability. AG-UI is an interaction projection, not a source of truth.
6. **Reliable state.** Use Kinmesh-owned transactional storage (SQLite + WAL for an initial single-node implementation, or justified alternatives), database-backed outbox/inbox and stable idempotency. Avoid custom JSON-file mutexes and PID-based ownership.
7. **Evidence-led releases.** Keep unit tests, typed schema/contract tests, authenticated live T3 integration tests, real-agent collaboration tests, and browser E2E separate. A mock-only green CI is not a product acceptance.

## Starting point

The authoritative rebuild plan and acceptance criteria are in [GitHub Issues #1–#9](https://github.com/ronhuafeng/kinmesh/issues). Begin with [#1: architecture and strict TypeScript foundation](https://github.com/ronhuafeng/kinmesh/issues/1), [#2: T3 external MCP integration](https://github.com/ronhuafeng/kinmesh/issues/2), and [#3: agent identity and authentication](https://github.com/ronhuafeng/kinmesh/issues/3).

There is intentionally no implementation code or runnable UI in this reset commit.
