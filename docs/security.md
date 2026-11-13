# Security

Kinmesh is a single-node, single-owner service with a loopback listener. This document owns every security rule and limit; other documents link here. Kinmesh secrets are separate from T3's credentials, and Kinmesh never reads T3's private storage or modifies its installation.

## Setup and onboarding

- `npm run setup` draws separate 256-bit setup and session secrets from the OS CSPRNG and creates `.env` exclusively with mode 0600; it never overwrites. Keep the working directory, `.env` and backups private; never put secrets in arguments, logs, CI, PRs or chat.
- `POST /api/setup` requires the setup secret as a bearer (compared in constant time) plus validated JSON. A committed singleton makes owner creation one-time, even under races or restarts. Setup returns public IDs and no session. Replacing the database resets this state and is a privileged, destructive act.
- `npm run onboard` masks the password, sends only to the configured loopback port, refuses redirects and prints fixed outcomes. HTTP on loopback is the one plain-HTTP exception; a process that can bind that port or read the same user's files is already inside the trust boundary.
- Usernames are 3–64 lowercase letters, digits, `_` or `-`; passwords 15–128 characters.

## Passwords and sessions

- Passwords are hashed with Argon2id (19 MiB, two iterations, one lane). Unknown accounts verify against a dummy hash to bound timing differences.
- Sessions use `@fastify/secure-session`: an encrypted, authenticated `HttpOnly`, `SameSite=Strict` cookie, `Secure` for an HTTPS origin, expiring after one hour. Login regenerates the session. Sessions survive restarts only while the session key is unchanged; changing the key ends every session.
- Each session carries a mark of the password hash it signed in with, checked on every request. `POST /api/me/password` (current password required, rate-limited like login) therefore ends every other session at once, including copied cookies; the changing browser gets a new session. Deleting an account ends its access.
- Logout clears the browser cookie but does not revoke a copied cookie before it expires.

## Requests

- Every `/api/` route requires a principal unless it is explicitly public (`/api/setup`, `/api/setup/status`, `/api/login`). Non-team routes require a human. Human and agent credentials cannot be mixed.
- Actor headers and actor/identity/role query parameters are rejected (400); they are never identity.
- A mutating request with an `Origin` header must match `KINMESH_ORIGIN`. There is no CORS and no proxy trust.
- Rate limits are per client IP and in memory: 60 requests/minute overall by default (`KINMESH_RATE_LIMIT`, 1–100000), well above what a person does; 5/minute for setup, login and password change, which is fixed. They reset on restart and are not a distributed defence.
- Event streams (`GET /api/events`) are for signed-in humans and carry no data, only the revisions of what a view shows, which are hashes of what that person can already read. Each person may hold 8 and the hub 64; a stream ends after 10 minutes and the browser reconnects with its session. The session is rechecked on every change and every 25 seconds, so a changed password or lost membership ends its streams at once.
- JSON bodies are capped at 16 KiB. Errors are fixed messages that never echo input or internal exceptions.
- Every response carries `nosniff`, `Referrer-Policy: no-referrer` and a restrictive CSP (`default-src 'self'`, no objects, no framing). Credential-bearing and workspace responses are `Cache-Control: no-store`.
- Only `/` and the built `/assets/` tree are served; there is no repository or SPA fallback.
- `KINMESH_ORIGIN` must be HTTPS or exactly `http://127.0.0.1:<port>`. For remote access, put a same-origin HTTPS reverse proxy in front of the loopback listener; never expose the listener directly. The proxy must not log bodies, authorization or cookie headers.

## Agent credentials

- Grants are opaque 256-bit bearer tokens. Only SHA-256 digests are stored; no token is persisted or logged. Each grant binds immutably to one agent and team, expires (60 seconds to 90 days), and is checked with its scopes, the agent's lifecycle and membership on every request.
- A token is returned once, on issue or rotation, with `Cache-Control: no-store`; there is no recovery. The agent page holds it only in page memory, offers copy or a download for the worker's `tokenFile`, and drops it when dismissed; it never reaches browser storage, URLs or logs, and grant lists never contain it. Treat a token shown on a shared screen as exposed and rotate it.
- Who may issue, rotate and revoke grants, and what each scope allows, is in [collaboration](collaboration.md#grants-and-scopes).
- Anyone holding a bearer can use it until it expires or is revoked; there is no proof of possession. Use one narrowly scoped grant per agent and provider.

## Agent avatars

`PUT /api/teams/:teamId/agents/:agentId/avatar` accepts only the image bytes, typed `image/png`, `image/jpeg` or `image/webp`, at most 128 KiB. The type is decided from the content's signature, so SVG and anything else is refused. Only the team owner or the agent itself may set or remove it. Avatars are served with their detected type, `nosniff` and a sandboxing CSP.

## Hub-held worker secrets

For agents connected from the workspace, the hub holds the worker's Kinmesh tokens and the team's T3 OAuth credential as files in `<database directory>/managed/`. The directory is 0700 and must be owned by the hub's user and not a symlink; each file is 0600 and written atomically. They are never put in SQLite, logs, responses or the browser. Back up and protect the directory like the database. Every connect, disconnect and T3 route requires an owner session; agent bearers are refused. Revoking the hub's worker grant disconnects the agent; that grant cannot be rotated from the browser.

## T3 credentials

- T3 OAuth credential files are 0600, outside the repository, owned by the service user; loading rejects symlinks and shared, executable, oversized or wrong-endpoint files, and any scope beyond `orchestration:read` and `orchestration:operate`.
- Kinmesh asks for Supervised (`approval-required`) authority, never Full access, and never approves on the owner's behalf. Authorization URLs and callback values are never printed to logs; manual mode writes only to the controlling terminal. Never paste pairing codes, callback URLs or tokens into chat, issues or prompts.
- Workers never open consent or widen authority. A frozen delivery cannot move to a different T3 authority unless it provably never reached T3.
- **Check in T3** reads only, through the team's T3 connection; nothing in the request chooses the endpoint, credential, environment or thread. Every native failure is one generic error, and a T3 link is shown only after validating it against the team's T3 origin and the exact thread.
- The workspace probe for a local T3 contacts only `127.0.0.1:3773`.

## Team MCP

The Team MCP listener binds `127.0.0.1` only. Plain-HTTP clients must use `http://127.0.0.1:<port>/mcp`; remote clients use a same-host HTTPS reverse proxy with `KINMESH_TEAM_MCP_ORIGIN`. Host must match the configured origin or the exact loopback host; an `Origin`, when present, must match exactly. Limits: 16 KiB bodies, 600 requests/minute per connected IP (proxied clients share one bucket), 10-second request and connection timeouts, 16 requests in progress by default (1–64; overload is 503) and 128 connections. Results are not cacheable. Bearer authentication only; no cookies, no sessions, no OAuth.

## Team content and agent prompts

- Message bodies are text; the workspace renders a safe Markdown subset, never HTML, with links only to `http(s)` in a new tab with `noopener noreferrer`.
- Agents receive team content as JSON in an ordinary user turn marked as untrusted data, never in system or developer context, and never as tool authorization. T3 keeps `approval-required`.
- No T3 OAuth file, provider login, agent grant or prompt is sent to the browser.

## Files and storage

The hub, worker, Team MCP and the T3 sign-in and live-gate scripts run with umask 0077. The default database directory is created 0700 and the database file is set to 0600; existing directories are the operator's responsibility. The database, WAL and backups hold prompts, messages, task content and idempotency receipts: protect them like credentials. Privileged database access is a trusted administration boundary, not a tamper-proof audit store. Never point `KINMESH_DATABASE` at another component's storage.

## Dependencies and guards

`npm audit --omit=dev` checks runtime dependencies (use a registry that implements the audit API). `package.json` overrides `glob` under `@fastify/static` to a patched release. `npm run architecture` statically rejects imports and resource strings that reach T3 internals and unsafe type suppressions; it is not a sandbox, so review every adapter and dependency change.

## Limits

- One node, one SQLite database; no multi-node deployment, online backup or disaster-recovery procedure.
- No human invitation beyond the first owner, password reset, MFA or account lockout.
- No server-side per-session revocation; key rotation ends all sessions.
- No proxy trust or distributed rate limiting.
- No proof-of-possession or theft detection for bearer tokens.
- Task acceptors cannot be reassigned.
