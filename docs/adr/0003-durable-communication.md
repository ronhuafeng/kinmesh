# ADR 0003: Kinmesh communication with atomic facts

Status: implemented for Issue #4; owner review pending.

Use ordinary HTTP and the existing verified human/agent principals. Channel visibility requires explicit joined membership, including owners. `channels:read` and `channels:write` are distinct agent scopes; descriptive role and provider identity confer no rights. Reuse current grant/lifecycle checks at the repository boundary, so stale principals and cursor/receipt replays cannot bypass removal or revocation.

Channels/topics/messages are independent Kinmesh resources, not T3 execution threads. Persist immutable messages with server-derived authorship, structured stable mention targets and causal references. No display-name mention parsing or user-role inference is an authorization source. Topic messages share one channel timeline row.

Reuse Drizzle/SQLite WAL immediate transactions for authorization, operation receipts, state, mentions and outbox facts. Explicit persisted integer positions enable bounded snapshot/keyset reads under concurrent appends. Cursors confer no authority. New communication mutations require actor/action/target-scoped idempotency keys; exact retries replay original results and changed payloads conflict. Outbox facts are versioned, immutable, durable inputs for #7, not a scheduler or delivery claim.

Migration backfills only existing owners, and fresh bootstrap enrolls general/owner with a fact atomically. No applied migration, private T3 state, custom WebSocket server, JSON lock or execution harness changes. Reuse → Adapt → Extend → Build: existing principals, schemas and persistence first; minimal owned communication and event contracts fill the product gap. UI remains #8; automatic delivery remains #7.

See [API, recovery and acceptance evidence](../channels-messages.md).
