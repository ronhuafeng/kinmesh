# ADR 0005: Stateless agent-only Team MCP

Status: implemented; independent review required.

Reuse the installed official MCP SDK Streamable HTTP server, strict Zod schemas, verified agent grants and existing communication/task repositories. Team MCP is a separate process/listener, not part of T3's orchestration server. No new persistence or transport implementation is needed.

Choose stateless JSON-response HTTP: a fresh SDK instance owns each request, no cached authorized sessions or background streams. Authenticate bearer grants at HTTP entry and again at tool execution; repositories recheck current permission inside transactions. Scope/team/channel/assignment remain separate checks. No cookie, actor argument, metadata or descriptive provider role grants authority. Human administration and final acceptance are absent from the agent tool catalog.

Preserve existing CAS, idempotency receipts and transactional audit/outbox without duplicating team state. Tools expose validated success envelopes and redacted business failures; protocol initialization/discovery/notifications/errors belong to the SDK. Static tool discovery is not permission evidence.

Bind loopback, check Host/Origin, limit bodies/rate/concurrency and use HTTPS at an operator-managed external proxy. Explicit bearer configuration is supported; this does not claim OAuth-only client compatibility. Stolen bearer credentials require existing revoke/disable controls.

An independent SDK/process test proves protocol interoperability, not provider integration. Keep a separate failing-closed external T3-launched provider gate. Supported isolated provider configuration and actual read/post/claim/handoff evidence are required before claiming that acceptance. Shared T3 credentials/settings must not be rewritten to force a pass.
