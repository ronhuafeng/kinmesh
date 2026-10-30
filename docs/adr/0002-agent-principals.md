# ADR 0002: Stable agent identity and separate credential authority

Status: implemented for Issue #3; owner review pending.

An agent is a durable member of exactly one Kinmesh team. Its branded AgentId, team and creation timestamp never change. Role, descriptive capabilities, opaque memory reference and provider/environment preferences are editable by the human owner and audited. Disabled identities retain their history. Execution references and AG-UI/provider invocation IDs remain separate many-to-one associations, using the existing execution domain contract.

Keep the existing secure-session/Argon2 human authority. External agents use independent 256-bit Node crypto opaque credentials bound to one agent/team, with hash-only storage, required expiration, allowlisted scopes and final revocation. An agent's descriptive role never confers owner authority. The HTTP resolver accepts verified session-plugin state or a bearer credential, rejects mixed authority, and never consumes actor selectors. Persistence authorization revalidates current membership, grant and lifecycle on every access, including previously resolved principals; write checks and effects share immediate SQLite transactions. Later Team MCP must reuse these principal/authorization rules behind its own authenticated transport, not accept a principal in tool arguments.

SQLite tables, constraints and migration triggers enforce stable identity, immutable grant bindings and append-only correlation/runtime/audit records. Disabling an identity revokes all grants atomically; reactivation requires deliberate new issuance. No T3 OAuth credential is stored here, and disable does not stop T3 work implicitly. This preserves independent Kinmesh/T3 lifecycles.

Runtime events and correlation provenance are attributed reports. A provider user-role message cannot convert an agent to a human author. An execution success report is not human task acceptance or proof of native T3 completion. Automated dispatch/correlation, Team MCP, channel/task APIs and UI belong to their issues; no extra harness or transport is introduced.

See [API and acceptance evidence](../agent-identities.md) for implemented policies and deployment limits.
