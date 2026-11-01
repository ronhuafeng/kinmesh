# ADR 0007: The hub keeps the worker's secrets for agents connected from the workspace

Status: implemented (#63).

Making a first agent wakeable used to take six steps, half of them outside Kinmesh:

1. Type the T3 environment, provider and model IDs.
2. Copy a worker token into a 0600 file.
3. Run `npm run t3:auth`.
4. Hand-edit `inbox.json`.
5. Configure the agent's T3 provider.
6. Start a worker.

The worker already runs on the hub's host, shares its SQLite database, and can be supervised by the hub. Kinmesh can therefore do steps 1–4 and 6 itself without moving any trust boundary.

## Decision

- **Server-held tokens.** The hub may hold an agent's raw worker token. It is written as `{"token": …}`, mode 0600, to `<database directory>/managed/agents/<agentId>.json`, in a 0700 directory owned by the hub's user. It never goes into SQLite, logs, HTTP responses or the browser. This is the same file the operator used to create by hand on the same host, for the same worker, so the trust boundary does not change: Kinmesh simply stops making a person carry the secret. The worker credential is the existing Inbox scope set for 90 days.
- **Connect T3 from the browser.** An owner-only `POST /api/teams/:teamId/t3/connect` runs the existing SDK authorization flow on the hub. It uses the same loopback callback, `127.0.0.1:49871`, returns the approval URL to the owner's browser instead of printing it, and saves the credential with the existing private-file rules to `managed/t3-oauth.json`. An existing credential is replaced only when the owner asks. The connection's endpoint and environment ID, which are not secrets, are kept in `t3_connections`. Because the callback is on loopback, the approval must happen in a browser on the hub's host; for any other topology the CLI remains the documented path.
- **Pick, don't type.** `GET /api/teams/:teamId/t3/providers` reads T3's `orchestrator_capabilities` with the connected credential and returns provider and model IDs. The environment ID comes from the credential itself.
- **Connect an agent.** An owner-only `POST /api/teams/:teamId/agents/:agentId/connect` takes a provider, a model and `providerConfigured: true`, which is the owner's explicit assertion that T3 is set up, as before. In one transaction it updates the agent's preferences, issues the worker credential (rotating any previous one), and records a `managed_bindings` row holding only the agent, grant and provider. It then writes the token file. If the file cannot be written, the credential is revoked.
- **The worker follows the database.** On every loop the worker merges managed bindings with the operator's `inbox.json` bindings; the file wins when both name an agent. Agents therefore join or leave without a restart. Without `KINMESH_INBOX_CONFIG`, the hub supervises a worker only once a managed binding exists, at startup or on the first connect. With no managed bindings it starts none, exactly as before.
- **Lifecycle.**
  - Disconnecting, or revoking the managed credential from the credentials list, removes the binding and the file.
  - Manual rotation of the managed credential is refused; reconnecting rotates it.
  - Disabling an agent revokes all of its credentials, as before. Re-enabling a connected agent issues a fresh worker credential so it can be woken again.
- **Evidence, not authority.** Team MCP records when an agent's credential first authenticates, throttled to one write every 30 seconds, and the workspace shows it as "reached Team MCP". This proves the provider is set up. It does not gate anything: the provider only calls Team MCP during a run, so gating on it would deadlock.

## Still outside Kinmesh

Configuring the agent's isolated T3 provider with the Team MCP endpoint and its own Team MCP credential. Kinmesh must not write provider settings. The workspace issues that credential once and explains where it goes.
