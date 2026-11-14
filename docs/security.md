# Security

Kinmesh is a single-node service for one organization, with a loopback listener. This document owns every security rule and limit; other documents link here. Kinmesh secrets are separate from T3's credentials, and Kinmesh never reads T3's private storage or modifies its installation.

## Configuration

- `npm run setup` draws a 256-bit session key from the OS CSPRNG and creates `.env` exclusively with mode 0600; it never overwrites. The Feishu app secret goes in the same file. Keep the working directory, `.env` and backups private; never put secrets in arguments, logs, CI, PRs or chat. HTTP on loopback is the one plain-HTTP exception; a process that can bind that port or read the same user's files is already inside the trust boundary.
- The hub refuses to start without the Feishu app (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`) and the organization's mailbox domain (`KINMESH_EMAIL_DOMAIN`). The Inbox worker is started without the app secret.

## Sign-in and sessions

- There are no passwords. A person signs in with Feishu's OAuth authorization-code flow: `GET /login` sends the browser to Feishu with a random 256-bit `state`, whose SHA-256 digest the database keeps for ten minutes, and the same state in an `HttpOnly`, `SameSite=Lax` cookie scoped to `/login` (Lax, because Feishu sends the browser back from another site). `GET /login/callback` accepts the return only from the browser holding that cookie, and only once; anything else turns the browser back with `?signin=expired`. The authorization code is exchanged with the app secret server-side; the secret, code and user token never reach the browser or a log. The app also reads, with an app token it does not keep, only the organization's name.
- Who signs in is the person Feishu vouches for, by their `union_id`; a mailbox only admits them. Admission needs a non-empty `union_id` and tenant, and an enterprise mailbox, trimmed and lower-cased, whose domain is exactly `KINMESH_EMAIL_DOMAIN`. The account's own mailbox, which the person sets, is never read. Anyone else is turned back with `?signin=denied`; a Feishu failure with `?signin=unavailable`. One `union_id` is one person (a unique index), so a renamed mailbox stays the same person and a mailbox handed to someone new is someone new. The mailbox is stored as Feishu last reported it and identifies nobody, except once: a person from before Feishu sign-in, linked to a mailbox by an operator (`npm run link-human`), becomes the first Feishu identity to sign in with it. The first person to sign in creates the team; everyone after joins it. Deleting a person ends their access.
- Sessions live on the server. Signing in creates a session from a random 256-bit token; the database keeps only its SHA-256 digest, so a copy of the database cannot be replayed. The token travels in an `@fastify/secure-session` cookie: encrypted, authenticated, `HttpOnly`, `SameSite=Strict`, and `Secure` for an HTTPS origin. Signing in regenerates the cookie.
- Every request checks the session: it ends after 8 hours unused and 7 days after sign-in, whichever comes first, and once revoked. Last-seen is written at most once a minute. Logout revokes this session; **Sign out everywhere** (`POST /api/me/sessions/end`) revokes all of yours. A copied cookie is the same session and ends with it. Changing the session key ends every session.

## Requests

- Every `/api/` route requires a principal. Non-team routes require a human. Human and agent credentials cannot be mixed.
- Actor headers and actor/identity/role query parameters are rejected (400); they are never identity.
- A mutating request with an `Origin` header must match `KINMESH_ORIGIN`. There is no CORS.
- Only the proxies named in `KINMESH_TRUSTED_PROXIES` (addresses or CIDR ranges) may say, in `X-Forwarded-For`, who the client is; from anyone else the header is ignored and the connecting address is the client. An HTTPS origin requires the setting, since the hub listens on loopback behind a proxy and would otherwise count everyone as one client.
- Rate limits are per client IP and in memory: 60 requests/minute overall by default (`KINMESH_RATE_LIMIT`, 1–100000), well above what a person does; 10/minute for each of `/login` and `/login/callback`, which is fixed. They reset on restart and are not a distributed defence.
- Event streams (`GET /api/events`) are for signed-in humans and carry no data, only the revisions of what a view shows, which are hashes of what that person can already read. Each person may hold 8 and the hub 64; a stream ends after 10 minutes and the browser reconnects with its session. The session is rechecked on every change and every 25 seconds, so a revoked or expired session or lost membership ends its streams at once.
- Logs record failures only: a 5xx or a startup or worker failure with its route, method, request ID, error name, code, constraint and stack, and a refusal that a database constraint caused. Requests themselves are not logged, so URLs, headers, cookies, bodies, tokens, OAuth values and T3 responses never reach a log.
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

`PUT /api/teams/:teamId/agents/:agentId/avatar` accepts only the image bytes, typed `image/png`, `image/jpeg` or `image/webp`, at most 128 KiB. The type is decided from the content's signature, so SVG and anything else is refused. Only a person of the team or the agent itself may set or remove it. Avatars are served with their detected type, `nosniff` and a sandboxing CSP.

## Hub-held worker secrets

For agents connected from the workspace, the hub holds the worker's Kinmesh tokens and the team's T3 OAuth credential as files in `<database directory>/managed/`. The directory is 0700 and must be owned by the hub's user and not a symlink; each file is 0600 and written atomically. They are never put in SQLite, logs, responses or the browser. Back up and protect the directory like the database. Every connect, disconnect and T3 route requires a person's session; agent bearers are refused. Revoking the hub's worker grant disconnects the agent; that grant cannot be rotated from the browser.

## T3 credentials

- T3 OAuth credential files are 0600, outside the repository, owned by the service user; loading rejects symlinks and shared, executable, oversized or wrong-endpoint files, and any scope beyond `orchestration:read` and `orchestration:operate`.
- Kinmesh asks for Supervised (`approval-required`) authority, never Full access, and never approves on anyone's behalf. Authorization URLs and callback values are never printed to logs; manual mode writes only to the controlling terminal. Never paste pairing codes, callback URLs or tokens into chat, issues or prompts.
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
- Sign-in is Feishu only; MFA and account recovery are Feishu's.
- No distributed rate limiting: limits are per hub process.
- No proof-of-possession or theft detection for bearer tokens.
- Task acceptors cannot be reassigned.
