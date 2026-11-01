# ADR 0008: Connecting an agent asks for nothing the owner has to understand

Status: implemented. Amends [ADR 0007](0007-hub-managed-worker.md) and the retry rule in [Agent Inbox](../agent-inbox.md).

The first real use of the two-click flow turned up three problems:

- **The setup asked the owner to understand Team MCP.** Connecting required an isolated T3 provider wired to Team MCP, plus a checkbox asserting it was set up. Most owners can't judge that assertion, and the agent doesn't need it to answer. It is woken, runs in T3, and its reply is published as a message.
- **A read-only T3 approval looked like success.** T3 let the owner choose Read only, Kinmesh showed "connected", and every wake was then refused.
- **Reconnecting T3 couldn't unstick anything.** A request frozen under the old T3 authority was refused under the new one, even though it had never reached T3.

## Decision

- **Team MCP is optional and out of the way.** For agents connected from the workspace, the hub no longer requires an isolated, Team MCP-configured provider or an owner assertion, so any provider T3 offers can be chosen. Team MCP lives under **More → Let the agent act in Kinmesh while it works**, which issues its credential and explains where it goes. This relaxes the isolation requirement only for these agents. Runs keep T3's `approval-required` mode on scratch launches, and the provider has access to whatever the owner configured for it in T3. Operator bindings in `inbox.json` keep `externalTeamMcpConfigured: true` as before.
- **One next step at a time.** The agent panel shows a single next step: connect T3, then choose a model (one control listing each provider's models, leaving out providers without any), then one line saying the agent is ready. Joining the current channel is a note with a button, not a gate, because membership is per channel. Reconnecting T3, Team MCP and running the worker by hand are under **More**.
- **No URL to find.** The hub probes only the T3 desktop's fixed loopback address, `127.0.0.1:3773`. If T3 answers with a valid environment descriptor, connecting is one button; another T3 still takes its MCP URL.
- **Say what T3 granted.** `GET /api/teams/:teamId/t3` reports `access: operate | read` from the saved credential's scopes. A read-only grant is shown as the next step, "Give T3 permission to run", not as success. While waiting for approval the panel says to choose Supervised, and where to create a pairing code if T3 asks for one.
- **Retry after reconnecting.** A frozen launch may be frozen again under the current grant and T3 authority only if it provably never reached T3: no operation ID, no reference, and no execution-journal entry for its operation key. The journal is written before dispatch. A database trigger (migration 0009) enforces the same condition. Once a native operation may exist, the authority stays pinned and a mismatch is still refused.
