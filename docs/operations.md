# Operations

Running Kinmesh, its Inbox worker and Team MCP; the live gates against real T3; and CI. First-run setup is in the [README](../README.md#quick-start). Security rules for every step here are in [security](security.md).

## Running the hub

`npm start` applies migrations, then listens on `127.0.0.1:${KINMESH_PORT}`. It runs from source with the development dependencies installed by `npm ci`; keep `drizzle/` beside `src/`. `npm run build` also compiles a standalone server (`dist/src/server/main.js`) with staged assets and migrations. Without built assets, `/` returns 503 while the API keeps working. For UI work, run `npm run web:watch` beside `npm start` and reload after each build.

The hub writes JSON lines to standard output: one record per failure, with its request ID, route, error name, code, constraint and stack (what is never recorded: [security](security.md)). A process that cannot start or run, the Inbox worker and Team MCP included, prints one `…_failed` line with the same fields to standard error before it exits with 1.

| Variable                             | Meaning                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `KINMESH_SESSION_KEY`                | Required; 64 lowercase hex characters; `npm run setup` writes it to `.env`                           |
| `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | Required; the Feishu app people sign in through; its redirect URL is `KINMESH_ORIGIN/login/callback` |
| `KINMESH_EMAIL_DOMAIN`               | Required; only mailboxes in this domain may sign in                                                  |
| `KINMESH_DATABASE`                   | SQLite file (default `.store/kinmesh.sqlite`)                                                        |
| `KINMESH_ORIGIN`, `KINMESH_PORT`     | Public origin (an HTTPS origin, or exactly `http://127.0.0.1:<port>`) and listener port              |
| `KINMESH_INBOX_CONFIG`               | Optional operator worker configuration (below)                                                       |
| `KINMESH_RATE_LIMIT`                 | Requests per minute per client (default 60); see [security](security.md)                             |

`npm start` reads `.env` if present; managed deployments may inject the same variables instead. Missing or malformed values fail startup.

A person who used Kinmesh before Feishu sign-in keeps their identity by being linked to their mailbox before their first Feishu sign-in: `npm run link-human -- <username> <mailbox>`. Unlinked, they would sign in as someone new. Linking refuses a mailbox another person holds and a person who has already signed in with Feishu.

`GET /health` returns 200 when the database is ready and, while the hub supervises a worker, that worker's loop is running; otherwise 503. It never reports T3, OAuth, Team MCP or provider health.

Back up the database (and its WAL) before upgrades, and never copy a live database without accounting for the WAL. The database holds prompts and team content.

## Inbox worker

The worker claims Inbox deliveries, runs them through the [T3 adapter](t3.md) and publishes results; what it delivers and why is in [collaboration](collaboration.md#agent-inbox). It shares the hub's database. Choose one arrangement:

- **Connected from the workspace.** When any agent is connected on its agent page, `npm start` supervises a worker for it, with no configuration. Its secrets live in the [managed directory](security.md#hub-held-worker-secrets).
- **Supervised by the hub.** Set `KINMESH_INBOX_CONFIG` to a private configuration file; `npm start` supervises a worker for its bindings as well as the managed ones.
- **Independent.** Leave the variable off the hub and run `npm run inbox:worker` under your own service manager. Do not also let the hub supervise one by accident.

The worker merges managed bindings with the file's on every loop; the file wins for an agent named in both. Team MCP (`npm run team:mcp`) is always a separate process.

### Operator configuration

```json
{
  "database": "/private/kinmesh/team.sqlite",
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

The file is strict: `pollMs` 100–30000, at most 32 unique bindings (none is an idle worker). It and each token file must be regular, private (0600, owned by the service user, non-executable for the config) and small; symlinks are refused. For each binding:

1. Enroll the agent in its channels and set its preferences to the T3 environment ID, the isolated provider instance and an advertised model. The worker launches scratch threads in that environment.
2. Issue a credential with the worker scopes (the agent page's **Run the worker yourself** issues one) and save `{"token":"…"}` as `tokenFile`.
3. Obtain an operate-scoped T3 grant with [`npm run t3:auth`](t3.md#t3-sign-in) as `t3AuthFile`.
4. Configure the isolated provider for Team MCP through its own settings ([provider configuration](t3.md#provider-configuration)); `externalTeamMcpConfigured: true` records that you did.

```sh
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm start          # hub supervises
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:worker  # or: independent
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:status  # delivery counts per state
```

Run every process as the same private OS user with `umask 077`. Configuration edits need a restart.

### Hub supervision

The hub validates the configuration before listening. The worker's `database` must resolve to the same absolute path as `KINMESH_DATABASE`; the database's device and inode are pinned across restarts, so replacing the file means stopping everything. The hub forks `src/inbox/main.ts` without the session key, the Feishu app secret or `NODE_OPTIONS`; each startup step has a 10-second deadline, and a failed start exits 1.

An unexpected worker exit gets **three replacements per hub lifetime**, after 250, 500 and 1000 ms; exhausting them stops the hub with exit 1, so the outer service manager can alert and restart. `SIGTERM`/`SIGINT` stop the worker first: it gets 10 seconds to abort claims and close SQLite, then SIGKILL and five more seconds. Allow at least 20 seconds for hub shutdown. If the hub dies, the worker stops claiming and exits within 10 seconds. Native work is never interrupted by shutdown.

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

One immediate transaction claims work: global capacity **two** across all processes, the oldest outstanding delivery per agent first, a new generation and random claim token, and a **180-second** lease in SQLite time. Every later write requires the current unexpired claim. Attempts abort after 90 seconds. Retries back off 1, 2, 4… seconds up to 300 and never exhaust during outages. A killed worker leaves its lease; the next claimer waits for expiry and reconciles the same native intent (see [durable operations](t3.md#durable-operations-and-recovery)).

To resume a blocked delivery after fixing its cause (anyone of the team can also do this from the workspace):

```sh
KINMESH_INBOX_CONFIG=/private/kinmesh/inbox.json npm run inbox:worker -- resume DELIVERY_UUID
```

Resume keeps the frozen intent, authority and native key. Never mint a new delivery or key to hide an ambiguous one.

Delivery, source and result identities are kept forever for idempotency; per-delivery diagnostic history is capped at 128 snapshots. There is no purge or disk quota: at storage thresholds stop intake, take a consistent backup and archive the installation. Never run a restored older backup against live native work without reconciling it.

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

**`test:live`** needs `KINMESH_T3_LIVE=1`, `KINMESH_T3_ENDPOINT`, an operate grant (`KINMESH_T3_AUTH_FILE`), a separate Read only grant (`KINMESH_T3_READ_AUTH_FILE`) for the same environment, `KINMESH_T3_PROVIDER`, `KINMESH_T3_MODEL`, and private `KINMESH_T3_LIVE_DATABASE` and `KINMESH_T3_LIVE_REPORT` paths. It spends two model turns on scratch threads and archives them; cleanup failure fails the gate.

**`test:team-live`** needs a fixture from `npm run team:live:prepare` (below), Team MCP running on its database, a dedicated provider instance configured for that endpoint and grant, and `KINMESH_TEAM_T3_LIVE=1`, `KINMESH_TEAM_LIVE_DIR`, `KINMESH_TEAM_T3_ISOLATED_PROVIDER`, `KINMESH_T3_ENDPOINT`, `KINMESH_T3_AUTH_FILE`, `KINMESH_T3_MODEL`. It launches one provider turn; the gate itself only reads.

**`test:inbox-live`** needs a fixture prepared with `KINMESH_TEAM_LIVE_SCENARIO=inbox` (which also requires `KINMESH_T3_ENVIRONMENT_ID`, `KINMESH_TEAM_T3_ISOLATED_PROVIDER` and `KINMESH_T3_MODEL`, and grants `executions:read`/`executions:write`), a worker configuration binding exactly that agent, and `KINMESH_INBOX_LIVE=1`, `KINMESH_TEAM_LIVE_DIR`, `KINMESH_INBOX_CONFIG`. Only the worker it starts dispatches.

**Fixtures.** `npm run team:live:prepare` with `KINMESH_TEAM_LIVE_DIR` (a **nonexistent** `kinmesh-team-live-*` directory directly under the system temporary directory) and `KINMESH_TEAM_MCP_ENDPOINT` creates a private team, channel, Developer and Reviewer, a one-hour Developer grant (`developer.json`), a source message, an unclaimed task and `context.json`, with no T3 or model calls. Never reuse a consumed fixture.

On failure, keep the fixture and inspect it through the workspace and T3 before cleanup. Afterwards stop Team MCP and workers, revoke the disposable Kinmesh and T3 grants, and remove only the directories you created. Never change shared provider settings or revoke shared grants.

### Release check

`npm run release:check` requires `KINMESH_RELEASE_LIVE=1` and an absolute `KINMESH_RELEASE_CONFIG`. It runs the three native gates with separate fixtures, grants and provider instances. Use Node 24, `umask 077`, and one OS user throughout.

```sh
export KINMESH_T3_ENDPOINT=https://your-t3.example/mcp
export KINMESH_T3_ENVIRONMENT_ID=your-environment-id
export KINMESH_T3_MODEL=your-model-id
export RELEASE_SDK_PROVIDER=dedicated-sdk-provider
export RELEASE_TEAM_PROVIDER=dedicated-team-provider
export RELEASE_INBOX_PROVIDER=dedicated-inbox-provider

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
KINMESH_DATABASE="$RELEASE_TEAM_DIR/team.sqlite" KINMESH_TEAM_MCP_PORT=31001 \
KINMESH_TEAM_MCP_ORIGIN=http://127.0.0.1:31001 npm run team:mcp
KINMESH_DATABASE="$RELEASE_INBOX_DIR/team.sqlite" KINMESH_TEAM_MCP_PORT=31002 \
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

| Workflow                      | Trigger                               | Runs                                                                                                                                     |
| ----------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CI` → `foundation`           | Pull requests to and pushes on `main` | Build, type-aware lint, formatting, all unit/persistence/HTTP/process tests, migration drift, architecture guard, `npm audit --omit=dev` |
| `CI` → `chromium`             | Same                                  | `npm run test:browser`: real desktop and mobile Chromium against disposable databases                                                    |
| `Live collaboration`          | Manual dispatch on `main`             | `test:collaboration-live` for Codex and Grok, each on a fresh GitHub-hosted VM                                                           |
| `Authenticated T3 acceptance` | Manual dispatch on `main`             | `release:check` on the owner's `kinmesh-t3-acceptance` self-hosted runner                                                                |

`main` requires `foundation` and `chromium`. Routine CI has no model credentials and never starts a provider run; native DTO cases use labelled fixtures. Browser tests use real Chromium with generated secrets, no Inbox or T3 credentials, and no traces or video. A green CI run is not live evidence.

Both manual workflows check, before checkout, that the dispatcher and any rerun actor is the repository owner on `main` (and, for `Live collaboration`, a GitHub-hosted runner); the scripts check again. Neither runs on pull requests.

### Live collaboration

`Live collaboration` installs pinned T3, Codex and Grok releases (`tests/live/install.sh`; T3 and Grok checksum-verified) and runs, per executor, the complete workflow in disposable state: browser sign-in through a stand-in for Feishu, T3 OAuth from the workspace with separate Read only and Supervised grants, a Developer and a Reviewer through two full task cycles including human rework, a worker killed under a live lease and recovered, T3 stopped and restarted, replayed submissions, denied agent acceptance and spoofed headers, a Kinmesh restart, human acceptance, checking a run in T3 and revoked grants. Cleanup failure fails the job. It uses the `live` Environment secrets `LLM_API_KEY`, `CODEX_BASE_URL` and `GROK_BASE_URL`, given only to the test step. The simulated human's decisions test permissions, not product acceptance. Only `.live-evidence/*.json` (commit, versions, outcomes, hashed correlations, failure stage, hub responses per stage by method, path pattern and status, cleanup) is uploaded; logs, prompts, tokens and databases are not.

To run it locally on a trusted machine: Node 24, the three secrets, `KINMESH_LIVE_EXECUTOR=codex` or `grok`, absolute `KINMESH_T3_BINARY`, `KINMESH_CODEX_BINARY` and `KINMESH_GROK_BINARY`, Chromium, a build, a free `127.0.0.1:49871`, and no unrelated `.env`; then `npm run test:collaboration-live`. Dispatch on GitHub with `gh workflow run live.yml --ref main`. The gate drives the workspace at machine speed to check correctness, so it starts its hub with a high `KINMESH_RATE_LIMIT`; the limit itself is checked by `tests/server.test.ts`. Two optional inputs narrow a run: `executor` (`both`, `codex` or `grok`) and `through`, a stage name after which the run stops with its evidence (`stoppedAfter`); a misspelt stage fails before anything runs. For example, `-f executor=codex -f through=workspace-oauth-models-and-managed-worker` checks setup up to a ready worker.

On failure, read the redacted evidence for that commit, find the cause through T3 and Kinmesh, fix the responsible layer and run a new gate. Never delete journals, change operation keys, weaken assertions or redispatch for a green result.

Record release evidence in the release's GitHub issue.
