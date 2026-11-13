# Collaboration model and HTTP API

Kinmesh owns team identity, communication, task responsibility and human acceptance. T3 owns provider sessions, threads, runs and execution records; Kinmesh reaches it only through the [T3 adapter](t3.md). This document is the reference for the domain model, the HTTP API and its invariants. Authentication, cookies, credential storage and limits are in [security](security.md); running the service is in the [README](../README.md) and [operations](operations.md).

## Principals and agent identities

Every protected request resolves its principal again: a human from the verified encrypted session, an agent from `Authorization: Bearer <grant>`. Mixing both is rejected. Actor headers (`X-Kinmesh-Actor`, `X-Actor-Id`, `X-Member-Id`, `X-User-Id`), actor/identity/role query fields and author fields in bodies are rejected; a declared message role is never identity. Repositories recheck grant, scopes, lifecycle, team and channel membership inside each transaction, so a revocation takes effect on the next operation.

A branded `AgentId` is independent of `HumanId` and of every T3 identifier (environment, thread, run, provider session, AG-UI invocation). Changing provider, model or environment preferences keeps the agent's ID, team, creation time and history.

Let `A = /api/teams/:teamId/agents` and `P = A/:agentId`. IDs are UUIDs.

| Method/path                             | Policy / body                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST A`                                | Human team owner; full profile; 201                                                         |
| `GET A`                                 | Human team owner; includes disabled profiles                                                |
| `GET P`                                 | Owner, or the matching active agent with `agents:read`                                      |
| `PUT P`                                 | Owner; replaces the full editable profile; IDs, team and creation time forbidden            |
| `PUT P/avatar`, `DELETE P/avatar`       | Owner or the agent itself; body is the image (see [security](security.md#agent-avatars))    |
| `GET P/avatar`                          | Owner, or the matching agent with `agents:read`; 404 when none                              |
| `POST P/lifecycle`                      | Owner; `{ "lifecycle": "active" }` or `disabled`                                            |
| `POST P/grants`                         | Owner, active agent; grant input; 201 `{grant,token}`, `Cache-Control: no-store`            |
| `GET P/grants`                          | Owner; metadata, scopes, expiry, revocation; never a hash or secret                         |
| `POST P/grants/:grantId/revoke`         | Owner; 204; final                                                                           |
| `POST P/grants/:grantId/rotate`         | Owner; grant input; atomic revoke + new secret; 201; 409 for the hub's own worker grant     |
| `GET P/audit`                           | Owner; immutable profile, grant, avatar and association history                             |
| `POST P/executions`                     | Owner or matching agent with `executions:write`; active profile; immutable correlation; 201 |
| `GET P/executions`                      | Owner or matching agent with `executions:read`                                              |
| `POST P/executions/:executionId/events` | Owner or matching agent with `executions:write`; active profile; `{state}`; 201             |
| `GET P/executions/:executionId/events`  | Owner or matching agent with `executions:read`; append-only reports                         |

A profile is:

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

Roles are `developer`, `reviewer` or `assistant`: descriptive, never authority. Names are unique within a team (trimmed, 1–80 characters). Capabilities are up to 32 unique labels of at most 256 characters, never scopes. Preferences are bounded IDs, null when unset; a model requires a provider. `memoryLocation` is an opaque reference of at most 1024 characters that is never dereferenced. `PUT` replaces the whole profile; audit keeps before/after snapshots.

### Grants and scopes

Grant input is `{ "label": "…", "scopes": [...], "lifetimeSeconds": 3600 }`: label 1–80 characters, 1–8 unique scopes, lifetime 60 seconds to 90 days.

| Scope                                 | Grants                                                        |
| ------------------------------------- | ------------------------------------------------------------- |
| `agents:read`                         | Reading the agent's own profile and avatar                    |
| `channels:read`, `channels:write`     | Reading channels; posting and creating topics                 |
| `tasks:read`, `tasks:write`           | Reading tasks and task facts; creating and work commands      |
| `tasks:review`                        | Technical review as the assigned reviewer                     |
| `executions:read`, `executions:write` | Reading; recording execution correlations and runtime reports |

Scopes are checked independently of channel membership, task assignment and role, and never widen when a profile changes. Only the human owner issues, rotates or revokes grants; agents cannot create identities, edit profiles or lifecycle, or administer grants. Human `member` memberships confer no owner administration.

Disabling an agent sets its lifecycle, revokes **all** its grants and writes audit in one transaction. Reactivation keeps identity and history but never restores old grants; when the agent is connected from the workspace, the hub issues its worker a fresh credential. Disabling does not stop T3 work already running or revoke T3 OAuth grants.

### Execution correlations

Correlation input is `{reference: {backend: "t3", environmentId, threadId, runId?}, providerSessionId, invocationId}` (IDs up to 256 characters, null when absent). One agent may have many correlations; a team cannot assign the same environment/thread/run tuple twice. Every correlation and runtime report carries a server-derived author (`human` + HumanId, or `agent` + AgentId and grantId).

Correlations are authorized assertions about an external reference, not proof that a run exists. Runtime reports (`unknown`, `active`, `waiting`, `succeeded`, `failed`, `stopped`) are attributed observations; they never call T3. Every correlation returns `acceptance: "not-evaluated"`; a reported success is never task acceptance. Execution truth comes only from T3 through the adapter.

SQLite composite foreign keys bind grants, correlations and audit to agent membership; triggers keep grant bindings, revocation, correlations, runtime reports and audit append-only.

## Channels, topics and messages

Let `C = /api/teams/:teamId/channels` and `P = C/:channelId`. Every write takes a caller-generated `operationKey` (1–128 of ASCII letters, digits, `.`, `_`, `:`, `-`); reuse it only to retry the same logical operation.

| Method/path                          | Input / policy                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `POST C`                             | `{operationKey,name}`; human team owner; 201, creator enrolled             |
| `GET C`                              | Page of joined channels                                                    |
| `GET C?membership=left`              | The caller's own left channels (up to 100); removed ones never listed      |
| `GET P`                              | Channel metadata; joined membership required                               |
| `GET P/membership`                   | Caller's own membership                                                    |
| `POST P/subscribe`                   | `{operationKey}`; rejoin a channel the caller left                         |
| `POST P/leave`                       | `{operationKey}`; leaves only the caller                                   |
| `POST P/participants/invite`         | `{operationKey,member}`; joined human owner; enrolls an active team member |
| `POST P/participants/remove`         | Same input; joined human owner                                             |
| `POST P/topics`                      | `{operationKey,title}`; joined participant; 201                            |
| `GET P/topics`, `GET P/topics/:id`   | Topic page; topic metadata in this channel                                 |
| `GET P/topics/:topicId/messages`     | Topic history page                                                         |
| `POST P/messages`                    | Post input below; joined participant; 201                                  |
| `GET P/messages`                     | Channel timeline page, including topic messages                            |
| `GET P/messages/:messageId`          | Immutable message                                                          |
| `GET P/messages/:messageId/mentions` | Structured mentions; same authorization as the message                     |
| `GET P/events`                       | Page of outbox facts for this channel                                      |

Reads require human team membership or an active agent grant with `channels:read`, **plus** joined channel membership; owners have no implicit bypass. Agent writes also need `channels:write`. Human members participate in enrolled channels but cannot create channels or manage participants; agents never can. Unknown and inaccessible channels return the same 404 and never appear in lists. Status codes: 401 invalid credentials, 403 missing scope/team/owner right, 400 schema or cursor error, 409 idempotency or uniqueness conflict. Errors never echo input.

Membership states are `joined`, `left` (the member may resubscribe) and `removed` (only an owner's invite restores it). Owners cannot remove themselves; they leave. The first owner is enrolled in `general` at setup. There is no public channel discovery and no self-join.

Post input (every field required; null means absent):

```json
{
  "operationKey": "discussion-001",
  "body": "Please review this proposal",
  "topicId": null,
  "mentions": [{ "kind": "agent", "id": "<AgentId>" }],
  "sourceMessageId": null,
  "sourceEventId": null
}
```

A mention target must be an active, joined participant of this channel; duplicates and disabled agents are rejected. `@text` is never parsed. Mentions grant no access. Topic and causal IDs must belong to the same channel. Messages have a stable ID, server-derived author and time, channel/topic IDs, a persisted position, structured mentions and causal IDs; they cannot be edited or deleted. Limits: body 1–8000 characters, title 160, channel name 80, 20 mentions, HTTP body 16 KiB. Bodies are plain text in the API.

## Tasks

Let `T = /api/teams/:teamId/channels/:channelId/tasks`. Every route rechecks joined channel membership. Agents also need `channels:read` and `tasks:read`; commands need `tasks:write`, except review, which needs `tasks:review`.

Any joined member with write authority may create an unowned task or one owned by themselves. Only a human team owner may preassign another member or a reviewer. The creating human owner becomes the immutable `acceptorHumanId`; for other creators the server designates the lowest-ID joined human owner (409 if none). Clients cannot choose or change the acceptor, and no other owner can accept. The acceptor must still be a joined team owner when deciding.

| Command                 | Legal state / actor                                            | Result                                                     |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| create                  | Authorized participant; optional owner                         | `proposed` if unowned, else `in-progress`                  |
| claim                   | Any authorized writer; `proposed`; not its preset reviewer     | `in-progress`, caller owns it                              |
| progress                | Work owner; `in-progress` or `rework-requested`                | `in-progress` with a note                                  |
| handoff (work)          | Work owner; `in-progress`/`rework-requested`                   | New owner, reviewer cleared; `in-progress`                 |
| handoff (work recovery) | Acceptor; any nonterminal owned task                           | Audited transfer to an active joined member; `in-progress` |
| handoff (review)        | Work owner; `in-progress`/`rework-requested`                   | Owner kept, distinct reviewer; `review-requested`          |
| request-review          | Work owner; `in-progress`                                      | Owner kept, distinct reviewer; `review-requested`          |
| review approve          | Assigned reviewer; `review-requested`                          | `awaiting-human` (**not accepted**)                        |
| review rework           | Assigned reviewer; `review-requested`                          | `rework-requested`                                         |
| rework                  | Acceptor; any nonterminal owned task                           | `rework-requested`                                         |
| accept                  | Acceptor; `awaiting-human`                                     | Terminal `accepted`, server human ID and time              |
| cancel                  | Acceptor; any nonterminal task                                 | Terminal `cancelled`, server human ID and time             |
| link-execution          | Work owner, or the assigned reviewer while review is requested | Immutable execution reference; state unchanged             |

Owner and reviewer must differ and stay active and joined. Rework always needs another review before acceptance. Terminal tasks reject every command. Title, description, criteria, creator, context and acceptor are immutable; progress is a note, not a patch. Audit keeps before/after snapshots, command, verified author (with grant ID for agents), time, version and event ID. Runtime completion is not part of the transition algebra; execution links and reports never accept a task.

| Method/path                               | Body                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST T`                                  | `{operationKey,title,description,criteria,topicId,owner,reviewer,sourceMessageId,sourceEventId}` → 201 |
| `GET T`                                   | Page of tasks                                                                                          |
| `GET T/:taskId`                           | Task                                                                                                   |
| `GET T/:taskId/history`                   | Page of immutable task events                                                                          |
| `GET T/:taskId/executions`                | Page of execution links                                                                                |
| `POST T/:taskId/claim`                    | Common fields                                                                                          |
| `POST T/:taskId/progress`                 | Common + `{note}`                                                                                      |
| `POST T/:taskId/handoff`                  | Common + `{recipient,mode:"work"\|"review",note}`                                                      |
| `POST T/:taskId/request-review`           | Common + `{reviewer,note}`                                                                             |
| `POST T/:taskId/review`                   | Common + `{decision:"approve"\|"rework",note}`                                                         |
| `POST T/:taskId/accept, /rework, /cancel` | Common + `{note}`                                                                                      |
| `POST T/:taskId/link-execution`           | Common + `{reference,note}`                                                                            |

Common command fields are `{operationKey,expectedVersion}`; the route names the command, so `type` in a body is rejected. A member is `{kind:"human"|"agent",id}` and names a target, never the caller. Nullable create fields must be explicit `null`. Limits: title 1–160, description 0–4000, criteria 1–20 distinct entries of at most 500, notes 1–2000 characters. Commands return `{task,eventId,executionLink}`. Status codes: 401/403 or hiding 404 for authorization, 400 schema or cursor, 409 transition, version or key conflict, 413 oversized body.

## Atomicity, idempotency and pagination

Every write runs in one immediate SQLite transaction that rechecks authorization, checks the operation receipt, applies the change (tasks use compare-and-set on ID, version, status and owner), appends audit and an outbox fact, enqueues any [Inbox](#agent-inbox) deliveries and stores the response receipt. Everything commits or nothing does. Triggers keep messages, mentions, task audit, links, receipts and outbox facts immutable.

Receipts are scoped by team, author, action and target and store a fingerprint of the validated payload (including `expectedVersion`). An exact retry returns the original response, even after later changes, without repeating effects; different input under the same key is 409. A replay is not a fresh snapshot: read again for current state. Membership changes check current rights before replay. Rotated grants keep agent identity, but a retry still needs a current grant with the right scopes and membership.

Lists take `limit` (1–100, default 50) and an opaque `cursor` (at most 2048 characters) and return `{items,nextCursor}`; null ends the scan. Ordering uses persisted positions. The first page fixes the highest visible position, so concurrent writes never shift, duplicate or leak into a scan; start a new scan to see them. A task scan fixes the set of tasks, not their values. Cursors are bound to the caller, team, view, channel, topic or task and are never authority: each page rechecks access, and a wrong-context cursor is 400.

### Outbox facts

`OutboxFact` (`src/domain/communication.ts`) is the versioned union of communication facts (`channel.created`, `participant.changed`, `topic.created`, `message.posted`) and `task.changed`. A fact carries its event ID, kind, team/channel/topic/message IDs, server author and time, mention targets, membership change, operation key and causal IDs. Task facts share their audit event's ID and carry task ID, version, status, action, owner, reviewer and any execution link. Facts omit message text and task content. `GET P/events` is channel-scoped; task facts appear only to principals with `tasks:read`. Facts confer no authority and do not imply delivery.

## Agent Inbox

The Inbox turns committed facts into bounded wakes of agents through T3. Deliveries are enqueued **inside the source transaction**; the worker that runs them is described in [operations](operations.md#inbox-worker).

### Wake policy and causality

- A human's message wakes each **structured mention** of an active, joined agent.
- Human task assignment, work or review handoff, request-review, human rework and reviewer rework wake the agent now responsible: the reviewer while review is requested, the owner while work or rework is active.
- Self-authored changes, progress, claims, execution links, acceptance, cancellation and agent chat wake no one.

Agents may hand tasks to agents. Causality comes from the task audit chain: a human action starts a root, and agent transfers spend a budget of **four** hops. `(root, agent)` uniqueness stops revisits; `(event, agent)` uniqueness makes delivery idempotent. Suppression affects delivery only; messages, decisions and facts are kept.

Enqueue never grants authority. Before dispatch and again at publication the worker rechecks the agent's credential, scopes (`channels:write` and `executions:write`, plus `tasks:write` for task wakes), lifecycle and membership; a fresh dispatch also needs current assignment. Worker identity comes from its token, not from configuration or event text.

### Delivery states

A delivery is `ready`, `waiting`, `uncertain`, `blocked`, `acked` or `expired`. A blocked delivery records a cause a person can fix: `agent-disabled`, `credential-invalid`, `not-in-channel`, `not-assigned`, `native-access`, `native-incompatible`, or `authority-or-contract-blocked` when none of these applies.

Owners resume a blocked delivery with `POST /api/teams/:teamId/deliveries/:deliveryId/resume` (owner session and channel read access; agent bearers are refused; keyed, so a retry replays). Resume keeps the frozen intent, authority and native request key, and authority is rechecked at dispatch and publication, so it cannot revive a revoked credential or switch to another.

Before any native effect, the worker freezes the source context, model, Kinmesh grant and T3 endpoint/environment/authority. Each delivery has the stable native identity `actor=inbox-agent:<AgentId>`, `operationKey=inbox:<DeliveryId>`. Changing the T3 authority, grant or model after freezing blocks the delivery rather than starting a new operation elsewhere. The one exception is a launch that provably never reached T3 (no operation ID, reference or journal entry): it is frozen again under the current authority. A database trigger enforces the same rule.

The prompt is the source context as JSON in an ordinary user turn, marked as untrusted data: author, team, channel, topic or task, source IDs, message text (up to 4000 characters), task title, description (2000) and up to five criteria (200 each), and the memory-location reference (never loaded). T3 permission mode stays `approval-required`.

### Results

The worker publishes only a nonempty `assistant_message` from the exact correlated run, after T3 reports it terminal with no pending requests. Pending approval keeps the delivery `waiting`; incomplete history keeps it retryable. Failed or stopped runs publish their real text with their real state; a run that ended without a reply publishes one plain sentence saying so. The message holds up to 6000 characters of the reply; its provenance (terminal state, shortening, provider, model, T3 environment/thread/run) is kept beside it, not in the text.

Publication is one fenced transaction: authority and assignment checks, execution correlation and runtime event, optional task execution link, the attributed message with the original source IDs, its outbox fact and receipt, the result record and the ACK. Result messages have no mentions and cannot wake anyone. Automatic execution links never change task state, review or acceptance.

An agent that keeps owner or reviewer responsibility may still settle a run it already dispatched after a handoff, approval, acceptance or rework. Reassignment, cancellation, revoked grants and removed membership block publication.

Work that never froze expires after seven days. Frozen, uncertain and correlated work never expires on its own, since a native effect may exist.

## Workspace snapshot

`GET /api/workspace` is a human-owner read that reconstructs, from Kinmesh's own data: the team, joined and left channels, the selected channel's messages, topics and tasks, agent profiles and avatars, and channel membership of agents. It takes only bounded cursors and channel/topic selection, never an actor, and responds `Cache-Control: no-store`. Its `revision` changes exactly when what it shows changes; the read time and worker heartbeats that change nothing on screen are left out. The AG-UI snapshot below carries the same kind of `revision` for the agent's runs. Pages hold up to 100 channels and profiles and 50 messages, topics or tasks.

It also carries:

- `deliveries` — for the visible messages and tasks: delivery ID, agent, source, state, reason, times and the reply message. Claims, frozen launches, operation IDs and native references stay in the worker.
- `replies` — for visible agent replies: outcome, model and T3 identifiers.
- `attention` — what waits on the signed-in owner across joined channels: `decide` (tasks awaiting their sign-off, review or rework; up to 50), `unstuck` (blocked deliveries; up to 50) and `connect` (agents with queued work and no live worker).
- `wake` — per agent, when a worker last recorded it and whether that is within 90 seconds (see [worker liveness](operations.md#worker-liveness)).
- `managed`, `teamMcp` — agents the hub runs, and when an agent's credential last reached Team MCP. Team MCP presence is evidence, not authority.
- `nativeT3Origin` — the origin of the team's T3 connection, used to [check a run](t3.md#checking-a-run), or null before Connect T3.

`GET /api/agui/:teamId/:memberId` returns one official AG-UI 1.0 `STATE_SNAPSHOT` event for an agent, validated on both ends with `@ag-ui/core` schemas: source `kinmesh-persisted-reports`, read time, the profile, up to 20 execution associations and 100 reports each, in persisted order. An AgentId is never an AG-UI invocation ID, and a ChannelId is never a T3 ThreadId.

Both are HTTP snapshots, not run or token streams: no `RUN_STARTED`, text deltas or approval controls are synthesized.

`GET /api/events` is a Server-Sent Events stream for one open view; its types are in `src/workspace/events.ts`. A view shows resources, each read by one route whose response carries its `revision`: `workspace` (`GET /api/workspace`), and on an agent page also `t3` (`GET /api/teams/:teamId/t3`, including a sign-in under way) and `runs` (`GET /api/agui/:teamId/:agentId`). The stream takes the snapshot's query and the page open on it (`page=agent:<id>`). Its only event, `revisions`, carries no data: the first names the revision of every watched resource, each later one only those that changed. The browser reads again exactly the resources whose revision differs from the one it holds, so a read it already made is not repeated, and a view that reconnects learns at once what it is behind on. **Refresh now** reads everything on screen. While the hub can be reached nothing is polled; while it cannot, the browser asks again every 5 seconds, and a stream the hub refused is opened again after the next successful read. The hub notices commits by the worker and Team MCP processes through SQLite's `data_version`, its own through `total_changes()`, and agents crossing the liveness window. How stale or failed reads appear is specified in [DESIGN.md](design/DESIGN.md#voice).

The browser sends a new `operationKey` for each logical action and the rendered `expectedVersion` for task commands. A request whose outcome is unknown keeps its exact body and key and is retried only on request, never automatically.
