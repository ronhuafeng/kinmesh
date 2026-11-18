# Security

Kinmesh is a single-node service for one organization, with a loopback listener. This document owns every security rule and limit; other documents link here. Kinmesh secrets are separate from T3's credentials, and Kinmesh never reads T3's private storage or modifies its installation.

## Configuration

- `npm run setup` draws a 256-bit session key from the OS CSPRNG and creates `.env` exclusively with mode 0600; it never overwrites. The Feishu app secret goes in the same file. Keep the working directory, `.env` and backups private; never put secrets in arguments, logs, CI, PRs or chat. HTTP on loopback is the one plain-HTTP exception; a process that can bind that port or read the same user's files is already inside the trust boundary.
- The hub refuses to start without the Feishu app (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`) and the organization's mailbox domain (`KINMESH_EMAIL_DOMAIN`). The Inbox worker is started without the app secret.

## Sign-in and sessions

- There are no passwords. A person signs in with Feishu's OAuth authorization-code flow: `GET /login` sends the browser to Feishu with a random 256-bit `state`, whose SHA-256 digest the database keeps for ten minutes, and the same state in an `HttpOnly`, `SameSite=Lax` cookie scoped to `/login` (Lax, because Feishu sends the browser back from another site). `GET /login/callback` accepts the return only from the browser holding that cookie, and only once; anything else turns the browser back with `?signin=expired`. The authorization code is exchanged with the app secret server-side; the secret, code and user token never reach the browser or a log. From the profile the hub keeps the person's name and [picture](#avatars), refreshed at every sign-in. The app also reads, with an app token it does not keep, only the organization's name.
- A sign-in returns to the place it began from (`GET /login?next=`, kept in a second `HttpOnly` cookie scoped to `/login` beside the state): only a path on this site, at most 512 characters, never a scheme, a host (`//…`) or a backslash; anything else returns to `/`. Inside the Feishu (Lark) client, whose authorization page asks nothing of a signed-in person, the sign-in page starts the sign-in at once, unless Feishu turned it back, access was lost, or the person signed out in that tab.
- Who signs in is the person Feishu vouches for, by their `union_id`; a mailbox only admits them. Admission needs a non-empty `union_id` and tenant, and an enterprise mailbox, trimmed and lower-cased, whose domain is exactly `KINMESH_EMAIL_DOMAIN`. The account's own mailbox, which the person sets, is never read. Anyone else is turned back with `?signin=denied`; a Feishu failure with `?signin=unavailable`. One `union_id` is one person (a unique index), so a renamed mailbox stays the same person and a mailbox handed to someone new is someone new. The mailbox is stored as Feishu last reported it and identifies nobody, except once: a person from before Feishu sign-in, linked to a mailbox by an operator (`npm run link-human`), becomes the first Feishu identity to sign in with it. The first person to sign in creates the team; everyone after joins it. Deleting a person ends their access.
- Sessions live on the server. Signing in creates a session from a random 256-bit token; the database keeps only its SHA-256 digest, so a copy of the database cannot be replayed. The token travels in an `@fastify/secure-session` cookie: encrypted, authenticated, `HttpOnly`, `SameSite=Strict`, and `Secure` for an HTTPS origin. Signing in regenerates the cookie.
- Every request checks the session: it ends after 8 hours unused and 7 days after sign-in, whichever comes first, and once revoked. Last-seen is written at most once a minute. Logout revokes this session; **Sign out everywhere** (`POST /api/me/sessions/end`) revokes all of yours. A copied cookie is the same session and ends with it. Changing the session key ends every session.

## Requests

- Every `/api/` route requires a principal. Non-team routes require a human. Human and agent credentials cannot be mixed.
- Actor headers and actor/identity/role query parameters are rejected (400); they are never identity.
- A mutating request with an `Origin` header must match `KINMESH_ORIGIN`. There is no CORS.
- Only the proxies named in `KINMESH_TRUSTED_PROXIES` (addresses or CIDR ranges) may say, in `X-Forwarded-For`, who the client is; from anyone else the header is ignored and the connecting address is the client. An HTTPS origin requires the setting, since the hub is reached only through its proxy and would otherwise count everyone not signed in as one client. Name every proxy between the client and the hub.
- Rate limits are in memory, counted per signed-in session and, for everyone else, per client address: 300 requests/minute by default (`KINMESH_RATE_LIMIT`, 1–100000), well above what a person does even with several tabs open, each of which fetches the workspace on every change, so people behind one address (an office, a VPN) each keep their own pace. A session is told by its sealed cookie, which nobody can make up, so the limit needs no lookup; a request without one (nobody signed in, an agent's bearer) counts against its address. `/login` and `/login/callback` are always counted by address, 10/minute each, which is fixed. The built `/assets/` files, immutable and served without reading any data, are not counted. Limits reset on restart and are not a distributed defence.
- Event streams (`GET /api/events`) are for signed-in humans and carry only what that person can already read: their workspace snapshot, as `GET /api/workspace` answers it, and the revisions (hashes) of the rest of what a view shows. A shared snapshot is only ever another view of the same person's same place. Each person may hold 8 and the hub 64; a stream ends after 10 minutes and the browser reconnects with its session. The session is rechecked on every change and every 25 seconds, so a revoked or expired session or lost membership ends its streams at once.
- `/metrics` answers this machine (the client address, through a trusted proxy if any) or `Authorization: Bearer` with `KINMESH_METRICS_TOKEN` (at least 32 characters, compared as digests in constant time); anyone else gets 403. Its labels are routes as patterns, methods, statuses and delivery states only.
- Logs record failures only: a 5xx or a startup or worker failure with its route, method, request ID, error name, code, constraint and stack, and a refusal that a database constraint caused. Requests themselves are not logged, so URLs, headers, cookies, bodies, tokens, OAuth values and T3 responses never reach a log.
- JSON bodies are capped at 16 KiB. Errors are fixed messages that never echo input or internal exceptions.
- Every response carries `nosniff`, `Referrer-Policy: no-referrer` and a restrictive CSP (`default-src 'self'`, no objects, no framing). Credential-bearing and workspace responses are `Cache-Control: no-store`.
- Only `/` and the built `/assets/` tree are served; there is no repository or SPA fallback.
- `KINMESH_ORIGIN` must be HTTPS or exactly `http://127.0.0.1:<port>`. For remote access, put a same-origin HTTPS reverse proxy in front of the hub. Only that proxy reaches the plain-HTTP listener: on loopback when it runs on the same host, otherwise over an encrypted private network (such as a WireGuard tailnet) whose access rules admit only the proxy. Never expose the listener on a public or shared network. A container listens on `0.0.0.0` (`KINMESH_HOST`) only inside its own network: a port published to the host's loopback, or a cluster network behind its ingress. The proxy must not log bodies, authorization or cookie headers.

## Agent credentials

- Grants are opaque 256-bit bearer tokens. Only SHA-256 digests are stored; no token is persisted or logged. Each grant binds immutably to one agent and team, expires (60 seconds to 90 days; only [the hub's own](#hub-held-worker-secrets) is renewed), and is checked with its scopes, the agent's lifecycle and membership on every request.
- A token is returned once, on issue or rotation, with `Cache-Control: no-store`; there is no recovery. The agent page holds it only in page memory, offers copy or a download for the worker's `tokenFile`, and drops it when dismissed; it never reaches browser storage, URLs or logs, and grant lists never contain it. Treat a token shown on a shared screen as exposed and rotate it.
- Who may issue, rotate and revoke grants, and what each scope allows, is in [collaboration](collaboration.md#grants-and-scopes).
- Anyone holding a bearer can use it until it expires or is revoked; there is no proof of possession. Use one narrowly scoped grant per agent and provider.

## Avatars

`PUT /api/teams/:teamId/agents/:agentId/avatar` accepts only the image bytes, typed `image/png`, `image/jpeg` or `image/webp`, at most 128 KiB. The type is decided from the content's signature, so SVG and anything else is refused. Only a person of the team or the agent itself may set or remove it.

A person's picture is the one Feishu's profile points to, downloaded by the hub at sign-in: only over HTTPS, without credentials in the address or following a redirect, cut off past 128 KiB, and held to the same types and limit. A picture that can't be fetched or isn't one leaves the picture before and never fails the sign-in. Browsers get it from the hub, never from Feishu, and only the people of the team.

Avatars are served with their detected type, `nosniff` and a sandboxing CSP.

## Attachments

- **Who.** Only a person joined to the channel uploads to it; a person who reads it (joined, or looking in a public channel) opens its files, rechecked on every read; agents upload nothing.
- **Sizes.** A file is at most 200 MB. The team's files together are at most `KINMESH_ATTACHMENTS_ROOM` bytes (10 GiB by default), counting the same bytes once. Both are refused (413) before anything is kept: a file's size from its `Content-Length`, which the upload requires (411 without). The upload route alone takes a body that large; every other route keeps the 16 KiB limit.
- **Type.** The type is decided from the content's signature, never from the name or the request.
- **Serving.** PNG, JPEG, GIF and WebP show inline; everything else, SVG and HTML included, downloads (`Content-Disposition: attachment`). Every file is served with its detected type, `nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`, so one opened on its own runs nothing and reaches nothing.
- **Storage.** The bytes are kept in the state directory's `attachments/`, named by their SHA-256 and written whole (a temporary file, then renamed), mode 0600; they go once nothing refers to them.

## Notifications

- A push is encrypted for the one browser it goes to (Web Push, RFC 8291): the browser vendor's push service carries it but cannot read it. It holds a title and one line of at most 240 characters, never more of a message, and is sent only while its cause still concerns the person, checked as it is sent: they are still joined, and it is still unread or still waiting on them.
- The hub signs pushes with its own VAPID key pair, made once and kept as `push-keys.json` in `managed/` (below). Losing it ends every browser's notifications until each is turned on again.
- A browser's endpoint and keys are kept with the session that turned it on, and deleted when that session signs out or the person signs out everywhere; one whose session was revoked or is past its lifetime receives nothing. An endpoint is a credential: it is never logged, only a push service's status code is.
- The service worker (`/sw.js`) shows what is pushed and opens its place. It keeps only the app's own files — the page, its content-hashed assets and icons — so an installed Kinmesh opens at once and without the hub; never anything the hub answers about a team (`/api/…`), a sign-in, or what the page holds once signed in. It receives what the system shares to an installed Kinmesh (`POST /share`), keeps it on the device until the person places it in a channel, and the page removes it then.
- A notification goes to Feishu only for a person who turned that on, after the same checks, from the app's own bot (a `tenant_access_token` asked for each time): a card with its title, its line and a link to its place, to that person alone by their `union_id`. The hub keeps the card's message id and what it said, to turn it into 已处理 once settled; nothing else is changed or read in Feishu. A failure is logged by stage and status only.

## Hub-held worker secrets

For agents connected from the workspace, the hub holds the worker's Kinmesh tokens, the team's T3 OAuth credential from a person's sign-in (`t3-oauth.json`) and the session the deployment issued, if any (`t3-deployment.json`), as files in `managed/` in the state directory (`KINMESH_STATE`). The directory is 0700 and must be owned by the hub's user and not a symlink; each file is 0600 and written atomically. They are never put in the database, logs, responses or the browser. Back up and protect the directory like the database. Every connect, disconnect and T3 route requires a person's session; agent bearers are refused. Revoking the hub's worker grant disconnects the agent; that grant cannot be rotated from the browser.

The hub's worker grant ends 90 days after the hub last renewed it, and the hub renews it while it serves the agent: when the hub starts, every hour, and when someone connects the agent again, a grant with less than 60 days left (or already ended) gets 90 days from then. It is renewed in place, the same grant and the same token in the same private file, so nobody reconnects an agent because time passed and a run under way keeps the credential it started with. A revoked grant is never renewed. The token therefore still ages out wherever the hub no longer vouches for it: at once when the grant is revoked or the agent is disconnected or disabled, and within 90 days of a hub that stopped running. While the agent stays connected a copy of the token works as the file does; revoke the grant to end it. Grants a person issues are never renewed.

## T3 credentials

- A session T3 issued for the hub (`KINMESH_T3_CREDENTIAL_FILE`) is a bearer credential like any other: the deployment keeps it secret, readable only by the hub, with only the scopes the hub needs and a bounded lifetime it renews before expiry. A person's sign-in beside it may grant more; runs use the broader of the two while T3 honours it ([T3](t3.md#t3-sign-in)), so whoever approves Full access chooses it for every agent until it ends.

- T3 OAuth credential files are 0600, outside the repository, owned by the service user; loading rejects symlinks and shared, executable, oversized or wrong-endpoint files, and any scope beyond `orchestration:read` and `orchestration:operate`, or, with operate, the `settings:write` and `source-control:write` a Full access grant adds.
- Kinmesh asks T3 only for `orchestration:read` and `orchestration:operate`, launches every run in the mode the person approving chose, or the broadest below it that the provider runs, never above it ([T3](t3.md#operations)), and never approves on anyone's behalf. The person approving picks it: Supervised for a T3 they share or run beside other work, where T3 asks a person in T3 for every action that needs approval; under Auto, T3 alone judges which of an agent's actions proceed without a person. **Under a Full access grant agents run without any approval**: whatever a model decides runs in T3 with T3's own permissions, so choose it only for a T3 that runs isolated. Then the boundary is T3's container, not a person: its network policy must deny the hub, its database and anything else private, and allows only what T3 needs (the internet, for models). The container runs as a non-root user with no capabilities and no privilege escalation; beyond the runtime's default, its syscall filter allows only what the sandbox of T3's browser (Chrome) needs: creating user and PID namespaces, and `chroot`. Any process there, an agent's included, may then hold capabilities inside namespaces of its own, which exposes more of the kernel to it; never disable Chrome's sandbox instead. A credential with any other scope is refused. Authorization URLs and callback values are never printed to logs; manual mode writes only to the controlling terminal. Never paste pairing codes, callback URLs or tokens into chat, issues or prompts.
- Workers never open consent or widen authority. A frozen delivery cannot move to a different T3 authority unless it provably never reached T3.
- **Check in T3** reads only, through the team's T3 connection; nothing in the request chooses the endpoint, credential, environment or thread. Every native failure is one generic error, and a T3 link is only ever to the exact thread on the team's T3 endpoint's own origin: the server builds it there, never from a link T3 returns, and the server and the browser each refuse any other origin, T3's hosted app included. The same holds for the link to a delivery's run.
- The workspace probe for a local T3 contacts only `127.0.0.1:3773`.
- In the agents' runtime, the coding agents (pi, Codex, Claude Code) live in the home folder on the deployment's volume, writable by the user T3 and its runs share, so an upgrade, or a change a run makes to them, outlasts a restart; T3 itself stays the image's and is changed only by a reviewed pull request ([newer T3](operations.md#newer-t3)).

## The space

- The provisioner's token (`KINMESH_SPACE_TOKEN_FILE`) is a bearer credential: the deployment keeps it secret, readable only by the hub, and the provisioner compares it in constant time. It allows only making a folder in the space a T3 project, placing or removing a message's files in that folder's `attachments/`, and minting a five-minute T3 pairing code; never reading files, or writing or removing anything else. A pairing code lets a browser into T3 with T3's default access: the hub gives one only to a signed-in person of the team (`POST /api/teams/:teamId/t3/pair`, never to an agent), never logs it, and T3 lists each pairing it makes, labelled Kinmesh, under **Settings → Sharing & access**, where it can be revoked.
- The worker reads it for each request and sends it only to `KINMESH_SPACE_ENDPOINT`, refusing redirects. Plain HTTP is for a private network the deployment controls, such as a cluster network whose policy admits only the hub to the provisioner.
- The provisioner takes a folder name, never a path: lowercase letters, digits and `-`, inside the space.

## Team MCP

The Team MCP listener binds `127.0.0.1` only. Plain-HTTP clients must use `http://127.0.0.1:<port>/mcp`; remote clients use a same-host HTTPS reverse proxy with `KINMESH_TEAM_MCP_ORIGIN`. Host must match the configured origin or the exact loopback host; an `Origin`, when present, must match exactly. Limits: 16 KiB bodies, 600 requests/minute per connected IP (proxied clients share one bucket), 10-second request and connection timeouts, 16 requests in progress by default (1–64; overload is 503) and 128 connections. Results are not cacheable. Bearer authentication only; no cookies, no sessions, no OAuth.

## Team content and agent prompts

- Message bodies are text; the workspace renders a safe Markdown subset, never HTML, with links only to `http(s)` in a new tab with `noopener noreferrer`.
- Agents receive team content in an ordinary user turn, inside marked blocks whose text is escaped so it cannot close them, and are told it is a request, not instructions or permission; never in system or developer context, and never as tool authorization.
- No T3 OAuth file, provider login, agent grant or prompt is sent to the browser.

## Files and storage

The hub, worker, Team MCP and the T3 sign-in and live-gate scripts run with umask 0077. The state directory's `managed/` is created 0700; existing directories are the operator's responsibility. The database and backups hold prompts, messages, task content and idempotency receipts: protect them like credentials. Privileged database access is a trusted administration boundary, not a tamper-proof audit store.

The database URL carries the database password: keep it in `.env` or the operator configuration, both private files, never in arguments or logs. Give Kinmesh a database of its own and a role that owns only it, never a superuser; never point `KINMESH_DATABASE_URL` at another component's database. Compose publishes PostgreSQL on this machine's loopback only. A database on another host must be reached over TLS (`?sslmode=verify-full` in the URL). The live gates' `KINMESH_DATABASE_ADMIN_URL` may create databases: use it only on a server for disposable ones, never on the team's.

## Dependencies and guards

`npm audit --omit=dev` checks runtime dependencies (use a registry that implements the audit API). `package.json` overrides `glob` under `@fastify/static` to a patched release. `npm run architecture` statically rejects imports and resource strings that reach T3 internals and unsafe type suppressions; it is not a sandbox, so review every adapter and dependency change.

## Limits

- One hub process; no multi-node deployment or disaster-recovery procedure.
- Sign-in is Feishu only; MFA and account recovery are Feishu's.
- No distributed rate limiting: limits are per hub process.
- No proof-of-possession or theft detection for bearer tokens.
- Task acceptors cannot be reassigned.
