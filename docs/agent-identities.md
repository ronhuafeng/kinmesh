# Durable agent identities and scoped principals (Issue #3)

Kinmesh owns agent identity, membership, credentials and attribution. T3 remains an unmodified external execution system. A branded `AgentId` is independent of `HumanId`, execution `environmentId`/`threadId`/`runId`, optional provider session and AG-UI invocation IDs. Agent profiles may have zero or many execution associations. Changing provider, model or environment preferences preserves the agent ID, team, creation timestamp and historical associations. No T3 service or credentials need changing for this feature.

Reuse → Adapt → Extend → Build: retain Fastify secure-session and Argon2 owner authentication, reuse Node's maintained cryptographic RNG/SHA-256 for high-entropy opaque credentials, Zod for strict domain/API validation, and Drizzle migrations/SQLite WAL transactions for owned data. No password hashing or session protocol is reimplemented. These are local API credentials, not T3 OAuth tokens or a new MCP transport.

## Owner setup and use

The existing clean-install sequence remains `npm ci`, `npm run setup`, `npm start`, then `npm run onboard` in another terminal. The setup CLI masks the password; the protected bootstrap endpoint requires the generated one-time secret. An anonymous first caller cannot claim ownership. Sign in through `POST /api/login` to obtain the verified encrypted session. Use a trusted local HTTP client that keeps credentials/cookies in private files; never put passwords or tokens in CLI arguments, logs or committed files. Remote deployment needs same-origin HTTPS as described in the security guide.

The API below is implemented and tested. There is no new agent management UI or dedicated grant CLI; the existing secure onboarding CLI is preserved. GET responses never return a token or its hash. Issuance/rotation returns a token once, with `Cache-Control: no-store`; save it immediately in a mode-0600 file outside version control. If the response is lost, use the protected grant list and revoke/replace the grant; there is no secret-recovery endpoint.

Let `A = /api/teams/:teamId/agents` and `P = A/:agentId`. IDs are UUIDs.

| Method/path                             | Policy / body                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST A`                                | Human team owner only; full profile; 201                                                    |
| `GET A`                                 | Human team owner only; includes disabled profiles                                           |
| `GET P`                                 | Owner, or matching active agent with `agents:read`                                          |
| `PUT P`                                 | Owner only; replace full editable profile; IDs, team and creation timestamp forbidden       |
| `POST P/lifecycle`                      | Owner only; `{ "lifecycle": "active" }` or `disabled`                                       |
| `POST P/grants`                         | Owner only, active agent; grant input below; 201 with `{grant,token}`                       |
| `GET P/grants`                          | Owner only; metadata/scopes/expiration/revocation, never hash/secret                        |
| `POST P/grants/:grantId/revoke`         | Owner only; 204; revocation is final                                                        |
| `POST P/grants/:grantId/rotate`         | Owner only; grant input; atomic revoke + new independent secret; 201                        |
| `GET P/audit`                           | Owner only; immutable typed profile/grant/association history                               |
| `POST P/executions`                     | Owner or matching agent with `executions:write`; active profile; immutable correlation; 201 |
| `GET P/executions`                      | Owner or matching agent with `executions:read`                                              |
| `POST P/executions/:executionId/events` | Owner or matching agent with `executions:write`; active profile; `{state}`; 201             |
| `GET P/executions/:executionId/events`  | Owner or matching agent with `executions:read`; append-only reports                         |

A profile contains all of:

```json
{
  "name": "Developer",
  "role": "developer",
  "capabilities": ["coding", "review"],
  "preferences": {
    "environmentId": null,
    "providerId": "codex",
    "modelId": null
  },
  "memoryLocation": null
}
```

Roles are `developer`, `reviewer`, `assistant` — descriptive, never owner authority. Names are unique within a team (case sensitive, trimmed, 1–80 characters). Capabilities are descriptive bounded labels, never credential scopes (32 unique entries, 256 characters each). Preferences are replaceable bounded IDs; model requires provider. Null means unset. This validates configuration syntax, not connectivity or ownership of an external T3 target; the existing execution adapter performs capability/provider/permission checks when executing. `memoryLocation` is an optional opaque reference of at most 1024 characters, never dereferenced, fetched or executed. Do not store secrets in profile fields. Full replacement PUT is deliberate; concurrent edits require owner coordination, with immutable before/after history available in audit.

Grant input is `{ "label": "Developer client", "scopes": ["agents:read", "executions:read", "executions:write"], "lifetimeSeconds": 3600 }`. Expiration is required, from 60 seconds to 90 days. Scope names are allowlisted and unique. `channels:read`/`channels:write` protect [Issue #4 communication](channels-messages.md); `tasks:read`/`tasks:write`/`tasks:review` protect [Issue #5 task routes](tasks.md). The scope array allows at most eight unique scopes; existing grants are unchanged. The standalone [Team MCP transport](team-mcp.md) reuses these grants and authorization rules. Channel/task scopes grant no profile/execution/owner rights. Profile role/capability changes never silently widen grant scopes. Only the human owner can issue/revoke/rotate; agents cannot create identities, modify profiles/lifecycle or administer grants. Human `member` memberships confer no owner administration in this initial policy.

External clients use `Authorization: Bearer <private-grant>`. Tokens contain 256 random bits; only SHA-256 digests are stored/indexed. SHA-256 is suitable for uniformly random high-entropy secrets; human passwords continue using Argon2id. No shared setup/session/T3 credentials are reused. Credentials bind immutably to one agent/team; every protected request resolves the principal again from secure-session or bearer. Mixed session+bearer authority is rejected. Bad, expired, revoked or disabled-agent grants fail authentication. No plaintext token is persisted in the DB, DTOs, audit or logs.

`resolvePrincipal` accepts only a verified session-plugin identity or an HTTP credential; future MCP integration must obtain the credential from its authenticated transport, never tool arguments. Repository authorization rechecks grants, scopes, active state, team and membership even for a previously resolved principal. This guards stale principals after revocation. Actor headers (`X-Kinmesh-Actor`, `X-Actor-Id`, member/user variants), actor/identity/role query selectors and extra body fields are rejected. A declared user-role/provider message is never an authentication input.

Disabling an agent updates lifecycle, revokes **all** grants and writes audit in one immediate transaction. Owner inspection remains possible. Reactivation retains identity/history but never resurrects old grants; issue a new credential explicitly. This blocks every implemented agent-specific profile/execution read/write. Shared authorization also rejects disabled/revoked agents for future channel/task scope checks. This does not cancel already running T3 work or revoke separate T3 OAuth grants; use the external adapter's authorized stop/revocation flows deliberately.

## Correlation, provenance and runtime lifecycle

Correlation input: `{reference: {backend: "t3", environmentId, threadId, runId?}, providerSessionId: string|null, invocationId: string|null}`. External identifiers are bounded to 256 characters. The reference reuses the Issue #2 domain `Reference`; none of its IDs become an `AgentId`. There can be multiple run-specific associations on one thread and agent; an idle/thread-only association is also possible. A team cannot assign the identical environment/thread/optional-run tuple twice, including to a second agent. Different teams retain isolated namespaces. Provider preferences can change without altering any association.

Every correlation and runtime event receives server-derived `author` (`human` + HumanId or `agent` + AgentId/grantId). An agent-origin follow-up represented as a T3 user-role message therefore remains agent-authored in Kinmesh's association record. Clients cannot submit author, agent/team identity or task acceptance. Actual channel/message persistence is deferred to its issue.

Associations are authorized assertions about an external reference, not proof that a T3 run exists or that the actor owns external T3 credentials. Runtime events are similarly attributed reports: `unknown`, `active`, `waiting`, `succeeded`, `failed`, `stopped`. They do not call T3 or assert authoritative native completion. Consumers needing execution truth must read through the Issue #2 authenticated adapter. Profiles have a separate `active`/`disabled` lifecycle. Every correlation returns `acceptance: "not-evaluated"`; a succeeded runtime report is never human acceptance. The Human → Developer → Reviewer → human acceptance flow still needs tasks, delivery and UI.

SQLite composite foreign keys bind grants/correlations/audit to agent membership. Unique indexes, immutable identity/grant bindings, final revocation and append-only correlation/audit/runtime triggers are committed in migration `0002_normal_talon.sql`. Profile, grant and audit writes transact together; failed rotation/disable/audit leaves no partial state. Migrations are deterministic and automatically applied before service listening. A new deployment upgrades existing foundation/adapter data without replacing T3. Back up the Kinmesh DB and WAL safely; privileged DB access is a trusted administration boundary, not a tamper-proof audit archive.

## Acceptance evidence and limits

The Issue #3 baseline suite included `tests/agents.test.ts`, which exercises actual SQLite and Fastify injection (not a mock identity service): create/read/list/update/disable/rebind, schema bounds/roles, uniqueness and team isolation, owner/member/agent policy, random/hash-only credentials, scope enforcement, spoofing and mixed authority, multi-run/provenance/history, expiry/revoke/rotate, stale principals, all implemented agent-specific profile/execution routes after disable/revoke, immutable SQL constraints/triggers, audit failure rollback, and service/DB reopen with persisted session/grant/history. Existing clean-install/secret bootstrap, process/WAL recovery, architecture negative fixtures and T3 contract tests remain required.

The populated foundation/adapter migration upgrade test preserves existing owner and uncertain-operation data. The real server subprocess test uses actual loopback HTTP for bootstrap/login, profile/grant issuance, scoped access and post-disable denial. Reopen tests preserve rebound role/configuration, credentials, revoked/disabled state and historical provenance. See [ADR 0002](adr/0002-agent-principals.md).

Run `npm ci`, `npm run check`, `npm run format:check`, `npm run build`, `npm audit --omit=dev`. No new dependencies or external private credentials are needed. This issue does not run the paid/authenticated T3 live gate and does not claim #9 E2E. Real T3 restart was not performed: agent persistence is independent, with Kinmesh service restart proven locally; T3 restart/upgrade execution recovery remains the documented adapter deployment gate. Agent management UI, actual Team MCP transport, task authorization routes, external binding discovery, automatic T3 correlation/dispatch, task acceptance, and remote/browser operational review remain later work. Do not interpret reserved scopes or attributed execution reports as those implemented features.
