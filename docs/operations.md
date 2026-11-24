# Operations

Running Kinmesh, its Inbox worker and Team MCP; the live gates against real T3; and CI. First-run setup is in the [README](../README.md#quick-start). Security rules for every step here are in [security](security.md).

## Running the hub

`npm start` applies migrations, then listens on `127.0.0.1:${KINMESH_PORT}`. It runs from source with the development dependencies installed by `npm ci`; keep `drizzle/` beside `src/`. `npm run build` also compiles a standalone server (`dist/src/server/main.js`) with staged assets and migrations. Without built assets, `/` returns 503 while the API keeps working. For UI work, run `npm run web:watch` beside `npm start` and reload after each build.

The hub writes JSON lines to standard output: one record per failure, with its request ID, route, error name, code, constraint and stack (what is never recorded: [security](security.md)). A process that cannot start or run, the Inbox worker and Team MCP included, prints one `…_failed` line with the same fields to standard error before it exits with 1.

| Variable                                                                          | Meaning                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KINMESH_SESSION_KEY`                                                             | Required; 64 lowercase hex characters; `npm run setup` writes it to `.env`                                                                                                                                                                                                                        |
| `FEISHU_APP_ID`, `FEISHU_APP_SECRET`                                              | Required; the Feishu app people sign in through; its redirect URL is `KINMESH_ORIGIN/login/callback`. For [notifications in Feishu](collaboration.md#notifications) the app also needs its bot and the permission to send messages as it (`im:message:send_as_bot`); without them only that fails |
| `KINMESH_EMAIL_DOMAIN`                                                            | Required; only mailboxes in this domain may sign in                                                                                                                                                                                                                                               |
| `KINMESH_DATABASE_URL`                                                            | Required; the PostgreSQL database, as a `postgres://` URL; `npm run setup` writes one for compose's database                                                                                                                                                                                      |
| `KINMESH_STATE`                                                                   | The hub's own files, such as the [managed directory](security.md#hub-held-worker-secrets) (default `.store`)                                                                                                                                                                                      |
| `KINMESH_S3_ENDPOINT`, `KINMESH_S3_ACCESS_KEY_ID`, `KINMESH_S3_SECRET_ACCESS_KEY` | Required; the [file store](#the-file-store), and the key the hub, the Inbox worker and Team MCP reach it with                                                                                                                                                                                     |
| `KINMESH_S3_PUBLIC_ENDPOINT`                                                      | Where browsers reach the store to upload (default `KINMESH_S3_ENDPOINT`)                                                                                                                                                                                                                          |
| `KINMESH_S3_BUCKET`, `KINMESH_S3_REGION`                                          | The bucket (default `kinmesh-files`) and the region the store signs for (default `us-east-1`)                                                                                                                                                                                                     |
| `KINMESH_ATTACHMENTS_ROOM`                                                        | The most the team's attached files may hold together, in bytes (default 10 GiB); [attachments](security.md#attachments)                                                                                                                                                                           |
| `KINMESH_ORIGIN`, `KINMESH_PORT`                                                  | Public origin (an HTTPS origin, or exactly `http://127.0.0.1:<port>`) and listener port                                                                                                                                                                                                           |
| `KINMESH_HOST`                                                                    | Listener address (default `127.0.0.1`); `0.0.0.0` only inside a container network behind the reverse proxy                                                                                                                                                                                        |
| `KINMESH_INBOX_CONFIG`                                                            | Optional operator worker configuration (below)                                                                                                                                                                                                                                                    |
| `KINMESH_RATE_LIMIT`                                                              | Requests per minute per session or address (default 300); see [security](security.md)                                                                                                                                                                                                             |
| `KINMESH_TRUSTED_PROXIES`                                                         | The reverse proxies, comma-separated addresses or CIDR ranges; required with an HTTPS origin                                                                                                                                                                                                      |
| `KINMESH_T3_ENDPOINT`, `KINMESH_T3_CREDENTIAL_FILE`                               | Optional, together; a T3 the deployment connects, and the file holding the session it issued for the hub; a person may still sign in to it ([T3](t3.md#t3-sign-in))                                                                                                                               |
| `KINMESH_SPACE_ENDPOINT`, `KINMESH_SPACE_TOKEN_FILE`                              | Optional, together; the [space](#the-space)'s provisioner, and the file holding its token                                                                                                                                                                                                         |
| `KINMESH_METRICS_TOKEN`                                                           | Optional; lets a scraper elsewhere read `/metrics` (at least 32 characters)                                                                                                                                                                                                                       |

`npm start` reads `.env` if present; managed deployments may inject the same variables instead. Missing or malformed values fail startup.

The database is PostgreSQL 17. For development, `docker compose up -d postgres silo` starts it and the [file store](#the-file-store) as `compose.yaml` describes: the database on loopback port 5433 (`KINMESH_POSTGRES_PORT`) with the password `KINMESH_POSTGRES_PASSWORD` from `.env`, the store on loopback port 9000 (`KINMESH_S3_PORT`). Any other PostgreSQL works too: give the hub a database of its own and a role that owns it. Tests start their own PostgreSQL and store in Docker, so running them needs Docker.

### The file store

The bytes of the files people attach are in an S3-compatible bucket, never in the hub: [silo](https://silo.pigsty.io) (`pgsty/silo`, a maintained MinIO), or any store that checks a PUT's signed `x-amz-checksum-sha256` and supports bucket lifecycle rules. The hub creates the bucket if it is missing and sets its one rule: uploads no one kept (`incoming/`) go after a day. Kept bytes are `files/<SHA-256>`, each once.

A browser uploads to the store itself, so `KINMESH_S3_PUBLIC_ENDPOINT` must be reachable from people's browsers, and the store must allow the workspace's origin (silo allows any origin by default); the hub adds that origin to its `connect-src`. Reached under the hub's own origin, it needs neither: route `/<bucket>/` there to the store, unchanged and with the original `Host` (the upload's signature covers both), taking bodies up to 200 MB (below). Downloads go through the hub, which streams them and answers a `Range` with that part. The hub, the Inbox worker and Team MCP reach the store at `KINMESH_S3_ENDPOINT`; none of them ever holds a whole file.

### GitHub

The hub reads the [pull requests linked to tasks](collaboration.md#pull-requests) from GitHub's REST API. A person connects the team's GitHub once in 设置 › 连接 › GitHub: GitHub's own pages create the team's GitHub App (named for the team, installable on any account or organization, with Contents and Pull requests read/write, Checks, Commit statuses and Metadata read, and no webhooks), then install it on the repositories they choose. The hub keeps the app's private key in `managed/github-app.json` and mints an installation token, valid an hour, when it needs one; the repositories to use are changed on GitHub (**更改**). Before a connection, the hub reads public repositories as an anonymous visitor, which GitHub allows 60 times an hour; each pull request takes three requests (itself, its check runs and its statuses). The app belongs to the connecting person's GitHub account and installs on whichever account or organization they choose; **重新连接** starts over (for example under another account). Every member of the team can see the linked pull requests of the repositories it reaches.

Every 30 seconds the hub asks about up to 20 pull requests that are due: never asked, with checks running and last asked a minute ago, open and last asked 5 minutes ago, or merged or closed and last asked 6 hours ago. A rate limit ends the round; the next one carries on. `pull_request_upkeep_failed` in the log means a round could not run.

### In a container

The image holds the compiled server, its migrations and the built workspace; it runs as the unprivileged `node` user, keeps its own files in the `/data` volume and reports healthy only when ready (`/health`). Everything else comes from the environment. `compose.yaml` runs it beside PostgreSQL, whose data is in the `kinmesh-postgres` volume. With a `.env` beside it (never committed; `npm run setup` writes one, then add the Feishu app and domain):

```sh
docker compose up -d --build
docker compose ps      # healthy once the database and worker are ready
```

The hub is published on this machine's loopback only (`127.0.0.1:3000`), for the reverse proxy below; its proxy then reaches it from the host, so `KINMESH_TRUSTED_PROXIES` names the Docker network's gateway (for the default bridge, `172.16.0.0/12`). Back up the `kinmesh-data` volume with the database (below). CI builds the image on every pull request. Each commit on `main` is published for linux/amd64 and linux/arm64 as `ghcr.io/ronhuafeng/kinmesh:<commit>`, beside the agents' runtime `ghcr.io/ronhuafeng/kinmesh-t3:<commit>` (`deploy/t3`: unmodified T3 Code at a pinned version, running `t3 serve` as a non-root user, and the coding agents it runs — pi, Codex and Claude Code. The image carries a version of each; as it starts (`agents.ts`) each goes into the home folder's npm prefix (`~/.local`, on the deployment's volume) unless one as new or newer is there, so an agent, T3 or a person upgrading one with npm or its own updater keeps that upgrade, and the image's version is the floor; its browser needs the syscall filter in [security](security.md#t3-credentials), and downloads Chrome when a browser tab first opens); deployments pin that commit ([deploying a commit](#deploying-a-commit)).

### Behind a reverse proxy

A loopback origin is for one person on this machine. A team reaches the hub through an HTTPS reverse proxy, on the same host or on another that reaches the hub only over an encrypted private network ([security](security.md)): `KINMESH_ORIGIN` is the public origin (Feishu's redirect URL is that origin plus `/login/callback`) and `KINMESH_TRUSTED_PROXIES` names every proxy on the way, so limits apply per person rather than to everyone at once. The proxy passes the original `Host`, sets `X-Forwarded-For`, keeps `/api/events` unbuffered (the hub also sends `X-Accel-Buffering: no`) with a read timeout above 30 seconds, and logs no bodies, cookies or `Authorization` headers. The hub compresses its answers itself (Brotli or gzip, as the browser takes them) and sends its web files as compressed when built; the event stream goes uncompressed, so each event arrives at once, and the proxy needs no compression of its own. The proxy serves the hub over HTTP/2 (in nginx, `http2 on;` in the `server` block): each open tab holds an event stream, and over HTTP/1.1 a browser keeps at most six connections to a site, so six open tabs would leave every other request waiting. With nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 60s;
}
# The file store, under the hub's origin: uploads straight from browsers.
location /kinmesh-files/ {
  proxy_pass http://127.0.0.1:9000;
  proxy_set_header Host $host;
  client_max_body_size 200m;
  proxy_request_buffering off;
  proxy_read_timeout 300s;
}
```

with `KINMESH_ORIGIN=https://kinmesh.example.com`, `KINMESH_S3_PUBLIC_ENDPOINT=https://kinmesh.example.com` and `KINMESH_TRUSTED_PROXIES=127.0.0.1`.

Behind two proxies, name both. For example, an edge nginx that forwards over a tailnet to a cluster's ingress controller needs `KINMESH_TRUSTED_PROXIES=<edge tailnet address>/32,<ingress pod range>`, and the ingress trusts forwarded headers only from the edge.

A person who used Kinmesh before Feishu sign-in keeps their identity by being linked to their mailbox before their first Feishu sign-in: `npm run link-human -- <username> <mailbox>`. Unlinked, they would sign in as someone new. Linking refuses a mailbox another person holds and a person who has already signed in with Feishu.

### Health and metrics

| Endpoint           | Answers                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health/live` | 200 while the process answers                                                                                                                                                                          |
| `GET /health`      | Ready: 200 when the database answers (it opens only fully migrated) and, while the hub supervises a worker, that worker's loop is running; otherwise 503. Never T3, OAuth, Team MCP or provider health |
| `GET /metrics`     | Prometheus text, for this machine or a bearer holding `KINMESH_METRICS_TOKEN` (see [security](security.md)); 403 otherwise                                                                             |

The two health endpoints answer `status`, `component` and `version`: the commit the hub was built from (`KINMESH_VERSION`, which the published image sets), or `null` for an image built elsewhere; nothing else, and no sign-in.

| Series                                  | Labels                      | Meaning                                                              |
| --------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `kinmesh_http_requests_total`           | `route`, `method`, `status` | Requests; `route` is the pattern, never an ID                        |
| `kinmesh_http_request_duration_seconds` | `route`, `method`           | Latency histogram                                                    |
| `kinmesh_rate_limited_total`            | `route`                     | Requests refused for a rate limit                                    |
| `kinmesh_deliveries`                    | `state`                     | Inbox deliveries by state                                            |
| `kinmesh_inbox_worker_up`               |                             | 1 while the supervised worker is connected                           |
| `kinmesh_agents_awake`                  |                             | Agents a worker can wake now                                         |
| `kinmesh_event_streams`                 |                             | Open event streams                                                   |
| `kinmesh_workspace_reads_total`         |                             | Workspace snapshots read; the views and reads of one place share one |
| `kinmesh_process_*`                     |                             | Node.js process: CPU, memory, event loop, GC                         |

No label carries anything a person wrote, a mailbox, a name or an ID.

### Backup and restore

Back up before every upgrade. A backup is the database, the state directory and the store's bucket together: the first two hold team content and credentials, and the bucket holds the bytes of the files people attached, which the database only describes. `pg_dump` takes a consistent copy of a running database:

```sh
docker compose exec -T postgres pg_dump -U kinmesh -Fc kinmesh > kinmesh.dump
```

To restore, stop the hub and every worker and Team MCP, then:

```sh
docker compose exec -T postgres pg_restore -U kinmesh -d kinmesh --clean --if-exists < kinmesh.dump
```

and put back the state directory and the bucket (for example with `mc mirror`) from the same time. Never run a restored older backup against live native work without reconciling it.

## Inbox worker

The worker claims Inbox deliveries, runs them through the [T3 adapter](t3.md) and publishes results; what it delivers and why is in [collaboration](collaboration.md#agent-inbox). It shares the hub's database. Choose one arrangement:

- **Connected from the workspace.** When any agent is connected on its agent page, `npm start` supervises a worker for it, with no configuration. Its secrets live in the [managed directory](security.md#hub-held-worker-secrets).
- **Supervised by the hub.** Set `KINMESH_INBOX_CONFIG` to a private configuration file; `npm start` supervises a worker for its bindings as well as the managed ones.
- **Independent.** Leave the variable off the hub and run `npm run inbox:worker` under your own service manager. Do not also let the hub supervise one by accident.

The worker merges managed bindings with the file's on every loop; the file wins for an agent named in both. Team MCP (`npm run team:mcp`) is always a separate process.

### Operator configuration

```json
{
  "database": "postgres://kinmesh:…@127.0.0.1:5433/kinmesh",
  "pollMs": 1000,
  "bindings": [
    {
      "agentId": "00000000-0000-4000-8000-000000000001",
      "tokenFile": "/private/kinmesh/developer.json",
      "t3Endpoint": "https://private-t3.example/mcp",
      "t3AuthFile": "/private/kinmesh/t3-oauth.json",
      "isolatedProviderId": "isolated-developer",
      "externalTeamMcpConfigured": true
    }
  ]
}
```

The file is strict: `pollMs` 100–30000, at most 32 unique bindings (none is an idle worker); agents connected from the workspace add to them without limit, and one worker serves them all. It and each token file must be regular, private (0600, owned by the service user, non-executable for the config) and small; symlinks are refused. For each binding:

1. Enroll the agent in its channels and set its preferences to the T3 environment ID, the isolated provider instance and an advertised model. The worker keeps one thread per agent and topic (and per agent and channel outside topics) in that environment: in the channel's project when the configuration names a space provisioner (`"space": {"endpoint": …, "tokenFile": …}`; the hub's `KINMESH_SPACE_*` otherwise), else a scratch thread.
2. Issue a credential with the worker scopes (the agent page's **自己运行工作进程** issues one) and save `{"token":"…"}` as `tokenFile`.
3. Obtain an operate-scoped T3 grant with [`npm run t3:auth`](t3.md#t3-sign-in) as `t3AuthFile`.
4. Configure the isolated provider for Team MCP through its own settings ([provider configuration](t3.md#provider-configuration)); `externalTeamMcpConfigured: true` records that you did.

```sh
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm start          # hub supervises
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:worker  # or: independent
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:status  # delivery counts per state
```

Run every process as the same private OS user with `umask 077`. Configuration edits need a restart.

### Hub supervision

The hub validates the configuration before listening. The worker's `database` must be the same URL as `KINMESH_DATABASE_URL`; the database's name and identity are pinned across restarts, so replacing the database means stopping everything. The hub forks `src/inbox/main.ts` without the session key, the Feishu app secret or `NODE_OPTIONS`; each startup step has a 10-second deadline, and a failed start exits 1.

An unexpected worker exit gets a replacement, at most **three in any ten minutes**, after 250, 500 and 1000 ms (fewer recent replacements, shorter wait); a replacement stops counting ten minutes after it, so a hub running for months survives rare crashes. One more within the ten minutes stops the hub with exit 1, so the outer service manager can alert and restart. `SIGTERM`/`SIGINT` stop the worker first: it gets 10 seconds to abort claims and close its connections, then SIGKILL and five more seconds. Allow at least 20 seconds for hub shutdown. If the hub dies, the worker stops claiming and exits within 10 seconds. Native work is never interrupted by shutdown.

### Independent supervision

```ini
[Unit]
Description=Kinmesh Agent Inbox
After=network.target

[Service]
Type=simple
User=kinmesh
WorkingDirectory=/opt/kinmesh
Environment=KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json
ExecStart=/usr/bin/node --import tsx /opt/kinmesh/src/inbox/main.ts
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=150
UMask=0077

[Install]
WantedBy=multi-user.target
```

Install the hub and Team MCP as their own units. Let the hub apply migrations before starting workers. An independent worker does not affect the hub's `/health`.

### Worker liveness

A running worker records each bound agent in `inbox_bindings` at most every 10 seconds and deletes its rows on a clean stop. The workspace shows an agent as online while its row is under 90 seconds old. Liveness means only that a worker would claim the agent's wakes now; it proves nothing about T3, OAuth, Team MCP or the provider, and confers no authority. Wakes for an agent without a worker wait, up to the seven-day lifetime of undispatched work.

### Scheduling and crash safety

One serializable transaction claims work, one claimer at a time across all processes (a transaction-scoped advisory lock): global capacity **two**, one claim at a time per conversation (agent, channel and topic), a delivery not yet in T3 only after the older ones of its conversation are, a new generation and random claim token, and a **180-second** lease in database time. Every later write requires the current unexpired claim. Attempts abort after 90 seconds. Retries back off 1, 2, 4… seconds up to 300 and never exhaust during outages. A killed worker leaves its lease; the next claimer waits for expiry and reconciles the same native intent (see [durable operations](t3.md#durable-operations-and-recovery)).

To resume a blocked delivery after fixing its cause (anyone of the team can also do this from the workspace):

```sh
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:worker -- resume DELIVERY_UUID
```

Resume keeps the frozen intent, authority and native key. Never mint a new delivery or key to hide an ambiguous one.

Delivery, source and result identities are kept forever for idempotency; per-delivery diagnostic history is capped at 128 snapshots. There is no purge or disk quota: at storage thresholds stop intake, take a [backup](#backup-and-restore) and archive the installation.

## The space

The space is a directory on the T3 machine where every channel is a T3 project, so agents in a channel share its files ([collaboration](collaboration.md#delivery-states)). The hub never touches it: it asks Kinmesh's **space provisioner** (`deploy/t3/space.ts`), which runs beside T3, for a channel's folder, and T3 for the project in it. The provisioner does what the hub cannot over MCP ([T3](t3.md#supported-t3)):

```http
POST {KINMESH_SPACE_ENDPOINT}/projects
Authorization: Bearer <token>
Content-Type: application/json

{"directory": "design-3f2a91c0", "title": "design"}
```

It answers `200 {"workspaceRoot": "/space/design-3f2a91c0"}` once that folder exists, is a git repository with a first commit, and is a T3 project (`t3 project add --title <title> <folder>`); for a folder that already is one, it answers the same without changing anything. `401` or `403` means the token is wrong. `directory` is lowercase letters, digits and `-`, at most 80 characters; the provisioner refuses anything else and never leaves the space.

It also places the files people attach to a message in the channel's folder, so agents find them in their working directory:

```http
PUT {KINMESH_SPACE_ENDPOINT}/projects/design-3f2a91c0/attachments/<AttachmentId>
Authorization: Bearer <token>
X-Kinmesh-Name: <the file's name, URI-encoded>
X-Kinmesh-Sha256: <the bytes' SHA-256, hex>

<the file's bytes, at most 200 MB>
```

It writes `<folder>/attachments/<first 8 of the ID>-<name>` whole (a temporary file, then renamed) and answers `200 {"path": "/space/design-3f2a91c0/attachments/3f2a91c0-screen.png"}`. The name keeps only letters, digits, `.`, `_`, `-` and spaces of its last segment, no leading dot, at most 100 characters, so nothing leaves `attachments/`. The same ID with the same bytes again changes nothing; with other bytes, `409`. Bytes that don't match the hash, or an ID that isn't one, are `400`; a folder it didn't make, `404`. `DELETE` on the same path removes the file, `200` also when it is already gone. The folder's `.git/info/exclude` lists `attachments/`, so the files stay out of agents' diffs and commits unless one copies them in. The worker streams the bytes from the [file store](#the-file-store) to the provisioner, which writes them as they come; neither holds a whole file.

`POST {KINMESH_SPACE_ENDPOINT}/pair` with `{"label": "Kinmesh"}` runs `t3 pair --ttl 5m --label <label>` and answers `200 {"token": "…", "expiresAt": "…"}`: a pairing code that lets a browser into T3 for five minutes, which the hub hands to a person in 连接 › T3 ([T3](t3.md#t3-adapter)).

The provisioner ships in the `kinmesh-t3` image as `/opt/kinmesh/space.ts` and runs with Node alone, wherever the `t3` CLI reaches T3's state: `node /opt/kinmesh/space.ts` beside T3 in the deployment, or `node deploy/t3/space.ts` on the machine running T3 desktop. It answers one request at a time and is configured by its environment:

| Variable                      | Meaning                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KINMESH_SPACE_DIR`           | The space; default `/space`. It must exist.                                                                                                               |
| `KINMESH_SPACE_HOST`, `_PORT` | Where it listens; default `127.0.0.1:3774`. Beside a remote T3, `0.0.0.0`, with a network policy that admits only the hub.                                |
| `KINMESH_SPACE_TOKEN_FILE`    | A file holding its token, made once (mode 0600) when missing or empty. Give the hub the same file as its own `KINMESH_SPACE_TOKEN_FILE`.                  |
| `KINMESH_SPACE_TOKEN_SECRET`  | Instead of a file, a Kubernetes Secret (`namespace/name`) whose `token` it makes once, through the API with the pod's service account; the hub mounts it. |
| `KINMESH_SPACE_ACCOUNT`       | That service account's directory (`token`, `ca.crt`); default the pod's own.                                                                              |
| `KINMESH_SPACE_T3`            | T3's CLI; default `t3`.                                                                                                                                   |

A hub on the same machine as T3 desktop gets a space with the provisioner started from the repository and the hub pointed at it:

```sh
KINMESH_SPACE_DIR=~/kinmesh-space KINMESH_SPACE_TOKEN_FILE=.store/space-token node deploy/t3/space.ts
# in the hub's .env
KINMESH_SPACE_ENDPOINT=http://127.0.0.1:3774
KINMESH_SPACE_TOKEN_FILE=.store/space-token
```

Every machine that mounts the space uses the same path, since T3 keeps projects by their folder. Back up the space with T3's own state: it holds the channels' work, and T3's projects point into it. Renaming or moving a folder breaks its project; Kinmesh keeps each channel's folder name in `channel_spaces`.

## Live and native gates

Routine CI never runs models. These gates use real T3 and models, cost money, and run only when an operator deliberately starts them on a reviewed revision. Each fails (exit 1) on missing opt-in or configuration; none skips. Each needs its own **new** disposable fixture.

| Command                           | Proves                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:contract`           | Adapter contract against captured schemas (fixtures; no T3)                                                                                                      |
| `npm run test:live`               | Adapter against real T3: nonce completion, follow-up interrupted while active, lost-reply replay with the same key, native denial for a Read only grant, cleanup |
| `npm run test:team-live`          | A T3-launched provider uses Team MCP: reads, posts, claims and hands off a disposable task                                                                       |
| `npm run test:inbox-live`         | Mention → ordinary worker → exact-run assistant reply → source-linked message; task stays unaccepted                                                             |
| `npm run release:check`           | All local checks, build, audit and Chromium, then the three gates above, isolated                                                                                |
| `npm run test:collaboration-live` | The complete product workflow in a disposable VM (the `Live collaboration` workflow)                                                                             |

**`test:live`** needs `KINMESH_T3_LIVE=1`, `KINMESH_T3_ENDPOINT`, an operate grant (`KINMESH_T3_AUTH_FILE`), a separate Read only grant (`KINMESH_T3_READ_AUTH_FILE`) for the same environment, `KINMESH_T3_PROVIDER`, `KINMESH_T3_MODEL`, a new, empty disposable database `KINMESH_T3_LIVE_DATABASE` (a URL whose database is named `kinmesh_live_` and 16 hex digits) and a private `KINMESH_T3_LIVE_REPORT` path. It spends two model turns on scratch threads and archives them; cleanup failure fails the gate.

**`test:team-live`** needs a fixture from `npm run team:live:prepare` (below), Team MCP running on its database, a dedicated provider instance configured for that endpoint and grant, and `KINMESH_TEAM_T3_LIVE=1`, `KINMESH_TEAM_LIVE_DIR`, `KINMESH_TEAM_T3_ISOLATED_PROVIDER`, `KINMESH_T3_ENDPOINT`, `KINMESH_T3_AUTH_FILE`, `KINMESH_T3_MODEL`. It launches one provider turn; the gate itself only reads.

**`test:inbox-live`** needs a fixture prepared with `KINMESH_TEAM_LIVE_SCENARIO=inbox` (which also requires `KINMESH_T3_ENVIRONMENT_ID`, `KINMESH_TEAM_T3_ISOLATED_PROVIDER` and `KINMESH_T3_MODEL`, and grants `executions:read`/`executions:write`), a worker configuration binding exactly that agent, and `KINMESH_INBOX_LIVE=1`, `KINMESH_TEAM_LIVE_DIR`, `KINMESH_INBOX_CONFIG`. Only the worker it starts dispatches.

**Fixtures.** `npm run team:live:prepare` with `KINMESH_TEAM_LIVE_DIR` (a **nonexistent** `kinmesh-team-live-*` directory directly under the system temporary directory), `KINMESH_TEAM_MCP_ENDPOINT` and `KINMESH_DATABASE_ADMIN_URL` (a role that may create databases, on any database of that server, such as `postgres`) creates a new `kinmesh_live_…` database holding a private team, channel, Developer and Reviewer, a one-hour Developer grant (`developer.json`), a source message, an unclaimed task and `context.json`, with no T3 or model calls. Never reuse a consumed fixture.

On failure, keep the fixture and inspect it through the workspace and T3 before cleanup. Afterwards stop Team MCP and workers, revoke the disposable Kinmesh and T3 grants, and remove only the directories and `kinmesh_live_` databases you created. Never change shared provider settings or revoke shared grants.

### Release check

`npm run release:check` requires `KINMESH_RELEASE_LIVE=1`, an absolute `KINMESH_RELEASE_CONFIG` and `KINMESH_DATABASE_ADMIN_URL`, on which it makes the SDK stage's database. It runs the three native gates with separate fixtures, databases, grants and provider instances. Use Node 26, `umask 077`, and one OS user throughout.

```sh
export KINMESH_T3_ENDPOINT=https://your-t3.example/mcp
export KINMESH_T3_ENVIRONMENT_ID=your-environment-id
export KINMESH_T3_MODEL=your-model-id
export RELEASE_SDK_PROVIDER=dedicated-sdk-provider
export RELEASE_TEAM_PROVIDER=dedicated-team-provider
export RELEASE_INBOX_PROVIDER=dedicated-inbox-provider
export KINMESH_DATABASE_ADMIN_URL=postgres://kinmesh:…@127.0.0.1:5433/postgres

umask 077
RELEASE_TMP=$(node -e 'console.log(require("node:fs").realpathSync(require("node:os").tmpdir()))')
export TMPDIR="$RELEASE_TMP"   # canonical path, also on macOS
RELEASE_SUFFIX=$(node -e 'console.log(require("node:crypto").randomUUID())')
export RELEASE_SDK_DIR="$RELEASE_TMP/kinmesh-t3-live-$RELEASE_SUFFIX"
export RELEASE_TEAM_DIR="$RELEASE_TMP/kinmesh-team-live-team-$RELEASE_SUFFIX"
export RELEASE_INBOX_DIR="$RELEASE_TMP/kinmesh-team-live-inbox-$RELEASE_SUFFIX"
mkdir -m 700 "$RELEASE_SDK_DIR"   # the preparer creates the other two

KINMESH_TEAM_LIVE_DIR="$RELEASE_TEAM_DIR" KINMESH_TEAM_LIVE_SCENARIO=team \
KINMESH_TEAM_MCP_ENDPOINT=http://127.0.0.1:31001/mcp npm run team:live:prepare

KINMESH_TEAM_LIVE_DIR="$RELEASE_INBOX_DIR" KINMESH_TEAM_LIVE_SCENARIO=inbox \
KINMESH_TEAM_T3_ISOLATED_PROVIDER="$RELEASE_INBOX_PROVIDER" \
KINMESH_TEAM_MCP_ENDPOINT=http://127.0.0.1:31002/mcp npm run team:live:prepare
```

The grants expire after one hour. Start one Team MCP per fixture and keep both running:

```sh
database() { node -p "require('$1/context.json').database"; }
KINMESH_DATABASE_URL="$(database "$RELEASE_TEAM_DIR")" KINMESH_TEAM_MCP_PORT=31001 \
KINMESH_TEAM_MCP_ORIGIN=http://127.0.0.1:31001 npm run team:mcp
KINMESH_DATABASE_URL="$(database "$RELEASE_INBOX_DIR")" KINMESH_TEAM_MCP_PORT=31002 \
KINMESH_TEAM_MCP_ORIGIN=http://127.0.0.1:31002 npm run team:mcp
```

If the providers run on another host, front each with its own HTTPS endpoint and prepare each fixture with that endpoint. Configure the Team provider with only the Team fixture's endpoint and `developer.json`, the Inbox provider likewise, each with a new private home; the SDK provider gets no Team access. Then obtain separate T3 grants with `npm run t3:auth`: `oauth.json` (read and operate) in each of the three directories, and `read-oauth.json` (read only) in the SDK directory.

Write the worker binding and release manifest (references only; no secrets are read):

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const e = process.env;
const context = JSON.parse(readFileSync(join(e.RELEASE_INBOX_DIR, 'context.json'), 'utf8'));
const native = (directory, providerId) => ({
  directory,
  endpoint: e.KINMESH_T3_ENDPOINT,
  authFile: join(directory, 'oauth.json'),
  providerId,
  modelId: e.KINMESH_T3_MODEL,
});
writeFileSync(join(e.RELEASE_INBOX_DIR, 'inbox.json'), JSON.stringify({
  database: context.database,
  pollMs: 1000,
  bindings: [{
    agentId: context.agentId,
    tokenFile: context.tokenFile,
    t3Endpoint: e.KINMESH_T3_ENDPOINT,
    t3AuthFile: join(e.RELEASE_INBOX_DIR, 'oauth.json'),
    isolatedProviderId: e.RELEASE_INBOX_PROVIDER,
    externalTeamMcpConfigured: true,
  }],
}), { mode: 0o600, flag: 'wx' });
writeFileSync(join(e.RELEASE_SDK_DIR, 'release.json'), JSON.stringify({
  sdk: { ...native(e.RELEASE_SDK_DIR, e.RELEASE_SDK_PROVIDER), readAuthFile: join(e.RELEASE_SDK_DIR, 'read-oauth.json') },
  team: { ...native(e.RELEASE_TEAM_DIR, e.RELEASE_TEAM_PROVIDER), externalTeamMcpConfigured: true },
  inbox: { directory: e.RELEASE_INBOX_DIR, configFile: join(e.RELEASE_INBOX_DIR, 'inbox.json') },
}), { mode: 0o600, flag: 'wx' });
JS

KINMESH_RELEASE_LIVE=1 KINMESH_RELEASE_CONFIG="$RELEASE_SDK_DIR/release.json" npm run release:check
```

Before any model runs, the aggregate rejects linked or non-private files, aliased fixtures, duplicate providers, wrong bindings, grants, scopes or preferences, non-fresh tasks (each must be `proposed`, version 1) and existing SDK output. It then probes T3, the providers and both Team endpoints read-only for all three stages. Each stage runs with an allow-listed environment and its own `HOME`, without inherited Kinmesh settings, `NODE_OPTIONS` or `.env`. A `.release-consumed` marker reserves every stage; any failure stops the aggregate and needs **new** fixtures, never a deleted marker or reset task.

## CI

| Workflow                      | Trigger                               | Runs                                                                                                                                                                     |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CI` → `foundation`           | Pull requests to and pushes on `main` | Build, type-aware lint, formatting, the design-token guard (below), all unit/persistence/HTTP/process tests, migration drift, architecture guard, `npm audit --omit=dev` |
| `CI` → `chromium`             | Same                                  | `npm run test:browser`: real desktop and mobile Chromium against disposable databases                                                                                    |
| `Live collaboration`          | Manual dispatch on `main`             | `test:collaboration-live` for Codex and Grok, each on a fresh GitHub-hosted VM                                                                                           |
| `Authenticated T3 acceptance` | Manual dispatch on `main`             | `release:check` on the owner's `kinmesh-t3-acceptance` self-hosted runner                                                                                                |
| `Publish image`               | Pushes on `main`                      | Both images for both architectures, then the [deployment](#deploying-a-commit)                                                                                           |

The design-token guard keeps [tokens/](../tokens) the one authority for the workspace's look ([DESIGN.md](design/DESIGN.md#colors)). `npm run design:check` fails when anything generated from the tokens is stale: the stylesheet's `web/shared/tokens.css`, DESIGN.md's frontmatter, and the theme colours of `web/index.html` and the web app manifest (`npm run design:build` regenerates them). `npm run lint:css` refuses, in any stylesheet, a raw colour, a corner other than the radius tokens, a custom property that hides a raw colour or shadow, or one that names nothing; a `stylelint-disable` comment does not turn it off. The type-aware lint refuses a colour literal or a `style` attribute in the workspace's code.

Tests run against PostgreSQL and the file store in Docker containers that each run starts once; every test's hub has a bucket of its own, and the database's migrated template is copied into a new database for every test, dropped afterwards. `main` requires `foundation` and `chromium`. Routine CI has no model credentials and never starts a provider run; native DTO cases use labelled fixtures. Browser tests use real Chromium with generated secrets, no Inbox or T3 credentials, and no traces or video. A green CI run is not live evidence.

Both manual workflows check, before checkout, that the dispatcher and any rerun actor is the repository owner on `main` (and, for `Live collaboration`, a GitHub-hosted runner); the scripts check again. Neither runs on pull requests.

Dependabot (`.github/dependabot.yml`) proposes updates weekly: npm minor and patch releases together in one pull request and each major alone, GitHub Actions, and the base images of `Dockerfile` and `deploy/t3/Dockerfile`. Its pull requests pass the same checks as any other.

### Deploying a commit

Merging to `main` deploys. Once `Publish image` has tagged `ghcr.io/ronhuafeng/kinmesh:<commit>`, its `deploy` job (also on a manual run on `main`) commits to `main` of `weavertech-group/infra` the hub image's `newTag` in `apps/kinmesh/kustomization.yaml`, set to the commit, and the agents' runtime's (`kinmesh-t3`) too when `deploy/t3` changed between the commit it runs and this one, so T3 restarts only for a new image; nothing else; Flux then applies it and waits for the pods to be ready, and the team's Feishu group hears of a failure, and also when `/health` still names another `version` 15 minutes after the tag changed (the infra repository's probe). Only the newest commit on `main` is deployed, so a run that finishes late changes nothing; when the tag already names the commit, the job changes nothing. The hub applies its migrations as it starts, and they only go forward.

To roll back, set that `newTag` in infra to an earlier commit; the database keeps the newer migrations. To pause deploying, remove the secret below: the job is then skipped, and the tag in infra is set by hand.

The job is skipped until the `infra` environment of this repository holds the secret `INFRA_PR_TOKEN`: a fine-grained personal access token with resource owner `weavertech-group`, repository access to `infra` only, the repository permission **Contents: Read and write** (Metadata: Read comes with it) and nothing else, approved by the organization if it requires that, with an expiry. Limit the environment's deployment branches to `main`, then:

```sh
gh secret set INFRA_PR_TOKEN --env infra --repo ronhuafeng/kinmesh
```

### Newer T3

Each day the `T3 version` workflow (`t3-update.yml`) pins a newer stable T3 Code release in `deploy/t3` through a pull request, once per release. It approves the pull request's CI (GitHub holds CI for pull requests from GitHub Actions until approved), and CI's image job builds the image, starts its T3, has it issue a session and runs `npm run t3:smoke` with it: every tool a run uses, its schemas and the environment, as Kinmesh reads them, with no model. Once the required checks pass the workflow merges it and starts `Publish image`, which deploys it ([deploying a commit](#deploying-a-commit)); a red check stops it there, as the [adapter](t3.md#supported-t3) needs work first. GitHub Actions may open the pull request only while the repository allows it (**Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**).

### Live collaboration

`Live collaboration` installs pinned T3, Codex and Grok releases (`tests/live/install.sh`; T3 and Grok checksum-verified) and runs, per executor, the complete workflow in disposable state: browser sign-in through a stand-in for Feishu, T3 OAuth from the workspace with separate Read only and Supervised grants, a Developer and a Reviewer through two full task cycles including human rework, a worker killed under a live lease and recovered, T3 stopped and restarted, replayed submissions, denied agent acceptance and spoofed headers, a Kinmesh restart, human acceptance, checking a run in T3 and revoked grants. Cleanup failure fails the job. It uses the `live` Environment secrets `LLM_API_KEY`, `CODEX_BASE_URL` and `GROK_BASE_URL`, given only to the test step. The simulated human's decisions test permissions, not product acceptance. Only `.live-evidence/*.json` (commit, versions, outcomes, hashed correlations, failure stage, hub responses per stage by method, path pattern and status, cleanup) is uploaded; logs, prompts, tokens and databases are not.

To run it locally on a trusted machine: Node 26, the three secrets, `KINMESH_LIVE_EXECUTOR=codex` or `grok`, absolute `KINMESH_T3_BINARY`, `KINMESH_CODEX_BINARY` and `KINMESH_GROK_BINARY`, Chromium, a build, a free `127.0.0.1:49871`, and no unrelated `.env`; then `npm run test:collaboration-live`. Dispatch on GitHub with `gh workflow run live.yml --ref main`. The gate drives the workspace at machine speed to check correctness, so it starts its hub with a high `KINMESH_RATE_LIMIT`; the limit itself is checked by `tests/server.test.ts`. Two optional inputs narrow a run: `executor` (`both`, `codex` or `grok`) and `through`, a stage name after which the run stops with its evidence (`stoppedAfter`); a misspelt stage fails before anything runs. For example, `-f executor=codex -f through=workspace-oauth-models-and-managed-worker` checks setup up to a ready worker.

On failure, read the redacted evidence for that commit, find the cause through T3 and Kinmesh, fix the responsible layer and run a new gate. Never delete journals, change operation keys, weaken assertions or redispatch for a green result.

Record release evidence in the release's GitHub issue.
