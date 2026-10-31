# Isolated native release checks

`npm run release:check` runs ordinary checks, formatting, build, production audit and real Chromium, then an opt-in native orchestrator. The orchestrator runs the existing SDK, Team and Inbox scripts in order with separate private configuration. It requires `KINMESH_RELEASE_LIVE=1` and an absolute `KINMESH_RELEASE_CONFIG` path. Missing prerequisites fail; there is no skipped pass or fallback to one inherited `KINMESH_TEAM_LIVE_DIR`.

This command can spend real Provider/model calls. Only an authorized operator may run it after reviewing the exact candidate. Normal Foundation/Chromium PR and push CI remain credential-free. The manual native workflow remains restricted to reviewed main on the owner's dedicated trusted runner; do not dispatch it to verify a PR.

## Prepare independent disposable fixtures

Use Node 24, `npm ci`, POSIX `umask 077`, and the same private OS owner for preparation and services. Do not use production Team data, shared Provider homes/settings, or an existing consumed fixture. The following prepares **two separate** Team contexts/databases; the third directory holds the existing SDK gate's scratch journal, reports and grants. Preparation makes no T3/model calls.

Choose actual private T3 endpoint/environment/model and three **different dedicated Provider instance IDs** through supported owner configuration. Provider login, external OAuth approval and Team MCP authorization are separate. Set these operator values explicitly:

```sh
export KINMESH_T3_ENDPOINT=https://your-owner-private-t3.example/mcp
export KINMESH_T3_ENVIRONMENT_ID=your-actual-primary-environment-id
export KINMESH_T3_MODEL=your-advertised-model-id
export RELEASE_SDK_PROVIDER=dedicated-sdk-provider-id
export RELEASE_TEAM_PROVIDER=dedicated-team-provider-id
export RELEASE_INBOX_PROVIDER=dedicated-inbox-provider-id

umask 077
RELEASE_TMP=$(node -e 'console.log(require("node:fs").realpathSync(require("node:os").tmpdir()))')
RELEASE_SUFFIX=$(node -e 'console.log(require("node:crypto").randomUUID())')
export RELEASE_SDK_DIR="$RELEASE_TMP/kinmesh-t3-live-$RELEASE_SUFFIX"
export RELEASE_TEAM_DIR="$RELEASE_TMP/kinmesh-team-live-team-$RELEASE_SUFFIX"
export RELEASE_INBOX_DIR="$RELEASE_TMP/kinmesh-team-live-inbox-$RELEASE_SUFFIX"
mkdir -m 700 "$RELEASE_SDK_DIR"
# Do not mkdir Team directories: the preparer requires nonexistent destinations.
KINMESH_TEAM_LIVE_DIR="$RELEASE_TEAM_DIR" \
KINMESH_TEAM_LIVE_SCENARIO=team \
KINMESH_TEAM_MCP_ENDPOINT=http://127.0.0.1:31001/mcp \
npm run team:live:prepare

KINMESH_TEAM_LIVE_DIR="$RELEASE_INBOX_DIR" \
KINMESH_TEAM_LIVE_SCENARIO=inbox \
KINMESH_TEAM_T3_ISOLATED_PROVIDER="$RELEASE_INBOX_PROVIDER" \
KINMESH_TEAM_MCP_ENDPOINT=http://127.0.0.1:31002/mcp \
npm run team:live:prepare
```

The Inbox preparation mode requires all three explicit native profile preferences and issues an expiring grant with channel/task scopes plus `executions:read`/`executions:write`. Default Team preparation remains unchanged. Credentials expire after one hour; finish deliberate configuration within that period or prepare new contexts. The preparer's random owner password is not an operator login credential.

Start **two separate Team MCP processes**, in separate terminals with the exported directory paths. Ensure the chosen ports are free and reachable from the dedicated Providers:

```sh
# Terminal 1: keep running during the gate.
KINMESH_DATABASE="$RELEASE_TEAM_DIR/team.sqlite" \
KINMESH_TEAM_MCP_PORT=31001 \
KINMESH_TEAM_MCP_ORIGIN=http://127.0.0.1:31001 npm run team:mcp

# Terminal 2: keep running during the gate.
KINMESH_DATABASE="$RELEASE_INBOX_DIR/team.sqlite" \
KINMESH_TEAM_MCP_PORT=31002 \
KINMESH_TEAM_MCP_ORIGIN=http://127.0.0.1:31002 npm run team:mcp
```

If T3/Providers run elsewhere, use two separate reachable HTTPS endpoints with the [supported Team reverse-proxy setup](team-mcp.md), and prepare each context using its corresponding public endpoint. Loopback examples require the native Providers to share that host/network namespace.

Through supported native operator configuration, give the Team Provider only the Team context's endpoint and `developer.json` grant; give the Inbox Provider only the Inbox context's endpoint and grant. Use separate new private Provider homes (0700; config files 0600), isolated from shared homes. Configure the SDK Provider separately without Team access. Kinmesh never edits Provider settings or reads their homes. Set only narrow required Team tools, keep native `approval-required` and approve individual operations deliberately. No Full access or automatic tool approval is authorized by this guide.

Obtain **separately approved external OAuth files** in each directory using the [existing OAuth flow](t3-adapter.md). Use `$RELEASE_SDK_DIR/oauth.json`, `$RELEASE_TEAM_DIR/oauth.json`, `$RELEASE_INBOX_DIR/oauth.json` with `orchestration:read orchestration:operate`; use `$RELEASE_SDK_DIR/read-oauth.json` with **only** `orchestration:read`, on the same native environment. For example, intentionally run the browser flow for each destination:

```sh
KINMESH_T3_AUTH_FILE="$RELEASE_TEAM_DIR/oauth.json" npm run t3:auth
# Repeat deliberately for the other three destinations, selecting the required grant scope.
```

Never print/copy token contents into logs, shell arguments, chat or GitHub. Authorization is a separate owner action; native browser pairing and Provider login are not substitutes. Do not copy a shared credential/home to bypass setup.

## Write private binding and release manifest

After configuring the dedicated Providers, the following creates references only. It reads the Inbox's disposable `context.json`, never its token or OAuth files. `externalTeamMcpConfigured: true` is your explicit assertion that the dedicated native Provider was configured for that stage, not an automated proof of its remote settings.

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
```

Only after exact candidate review and explicit authorization to spend native calls:

```sh
KINMESH_RELEASE_LIVE=1 \
KINMESH_RELEASE_CONFIG="$RELEASE_SDK_DIR/release.json" npm run release:check
```

The aggregate rejects symlinked/hard-linked/private-file violations, aliased contexts, duplicate Provider IDs, incorrect bindings/grants/scopes/profile preferences, nonfresh tasks/Inbox and existing SDK outputs. Both Team tasks must initially be `proposed` version 1. It authenticates reads against **both** Team endpoints, loads each explicitly referenced OAuth grant, and probes the native contract/environment plus advertised Provider/model/approval capability for **all three stages before spawning the first model-capable child**. The SDK Read only grant is checked separately. No preflight launches a thread or sends a model turn.

Each child receives its own allowlisted environment and private `HOME`, without inherited Kinmesh/Provider settings, `NODE_OPTIONS` or `.env` loading. The Team child must leave **its own task** `review-requested` version 3. The Inbox child uses its other fresh database/task/config and starts the ordinary Inbox worker. All existing native proof, OAuth, Team MCP, `approval-required`, failure and cleanup assertions remain mandatory. Independent `test:live`, `test:team-live` and `test:inbox-live` commands retain their existing environment contracts; independently prepare a new context for each invocation.

## Cleanup and evidence boundary

A `.release-consumed` marker reserves every stage before any native child starts. Any stage failure stops the aggregate; even partial failures require **new fixtures**, not marker deletion, task reset or replay against consumed data. A failure in later readiness may leave a private SDK journal created by preflight; prepare a new SDK directory. The aggregate never automatically deletes contexts or launches retries. Do not run any other worker against these disposable databases during the gate.

Keep the three directories until all known/uncertain native work has been reconciled. Existing gate cleanup attempts stop/archive of its disposable threads; failure is an owner inspection requirement, never successful acceptance. Then stop both separately managed Team MCP services and any remaining disposable worker, revoke the disposable Kinmesh and external OAuth grants through supported owner controls, and remove only the three exact new disposable directories you created. Retain sanitized evidence privately as required before removal. Remove only the dedicated Provider instances/homes you created, after their work has stopped; never alter shared settings or revoke shared grants. Stopping a client does not stop remote native work.

Static configuration and capability reads cannot prove remote Provider home isolation, native login health, future network availability, per-operation human approval or correct model behavior. The operator assertions and real native gates remain necessary. Credential-free regression tests exercise local SQLite, official Team MCP clients, mock native discovery and subprocess substitutes; they are **not genuine native acceptance**. A green Draft PR CI must not close #9 or establish a new authenticated release pass. Preserve the [historical acceptance record](acceptance/v01-workflow-2026-10-31.md) with its original scope; the aggregate must be independently witnessed on an authorized candidate before claiming new live evidence.
