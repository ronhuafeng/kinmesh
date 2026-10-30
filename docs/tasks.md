# Durable task responsibility (Issue #5)

Kinmesh owns responsibility and acceptance, independently of T3 runs, agent lifecycle and AG-UI. This feature reuses current human secure-session and hashed opaque agent credentials, Fastify, strict TypeScript/Zod, Drizzle and SQLite WAL. No dependencies, T3 changes, model calls, dispatch loop or workflow language are added.

## Authority and state policy

Every repository operation and HTTP route revalidates current team/channel joined membership. Agents also need `channels:read` and `tasks:read`; writes need `tasks:write`, except technical review needs `tasks:review`. Review-only grants do not need write scope. The allowlist now has eight unique scopes maximum. Existing grants are never widened: an old `tasks:write` grant alone cannot read or mutate tasks. Issue new least-privilege expiring grants through the existing human-owner API; disable revokes all grants, reactivation requires a new grant. Scope, descriptive role and assignment are independent checks. Mixed human-cookie/agent-token authority, actor headers/query fields and supplied command authors are rejected.

Any joined member with write authority may create an unclaimed task or assign themselves. Only a verified human team owner may preassign another active joined member or reviewer. The creating human owner becomes the immutable `acceptorHumanId`. For other creators, the lowest stable-ID joined human team owner is designated server-side (409 if absent). Clients cannot select or change the acceptor. Even a different team owner cannot accept that task. The designated human must still have team-owner role and joined channel membership at decision time.

| Command                 | Legal state / actor                                              | Result                                                                      |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| create                  | Authorized participant; optional work owner                      | `proposed` if unowned, otherwise `in-progress`                              |
| claim                   | Any authorized writer; proposed/unowned; not its preset reviewer | `in-progress`, caller becomes sole owner                                    |
| progress                | Work owner; in-progress or rework-requested                      | `in-progress`, bounded progress note                                        |
| handoff (work)          | Work owner; in-progress/rework-requested                         | Transfer responsibility, clear reviewer; `in-progress`                      |
| handoff (work recovery) | Designated human owner; any nonterminal owned task               | Audited transfer to an active joined recipient; clear review, `in-progress` |
| handoff (review)        | Work owner; in-progress/rework-requested                         | Keep work owner, assign distinct reviewer; `review-requested`               |
| request-review          | Work owner; in-progress                                          | Keep owner, assign distinct reviewer; `review-requested`                    |
| review approve          | Assigned reviewer; review-requested                              | `awaiting-human`, **not accepted**                                          |
| review rework           | Assigned reviewer; review-requested                              | `rework-requested`                                                          |
| rework                  | Designated human owner; any nonterminal owned task               | `rework-requested`                                                          |
| accept                  | Designated human owner; awaiting-human                           | Terminal `accepted`, server human ID/time                                   |
| cancel                  | Designated human owner; any nonterminal task                     | Terminal `cancelled`, server human ID/time                                  |
| link-execution          | Work owner or pending assigned reviewer; nonterminal             | Immutable reference association; state unchanged                            |

Assigned work owner and reviewer must remain active/joined for review or acceptance. Disabled principals cannot read or mutate any task surface, including replay; removed channel members see resource-hiding 404. The human can recover disabled-owner responsibility as above. If the designated acceptor loses team role/membership, trusted membership restoration is required; no acceptor reassignment endpoint exists. Rework requires another explicit review before human acceptance. Owner and reviewer must differ. Accepted/cancelled tasks reject all commands, including later execution links.

Task title, description, criteria, creator, context and acceptor are immutable. Progress updates are notes, not arbitrary patches. Audit retains before/after snapshots, command, verified author (agent includes grant ID), server time, task revision and stable event ID. Work handoff does not erase prior responsibility.

## HTTP API

Let `P=/api/teams/:teamId/channels/:channelId/tasks`. UUIDs are stable branded domain IDs. All mutations require `operationKey` (1–128 allowed ASCII letters/digits/`._:-`); commands also require `expectedVersion` from the task read. No current-actor selector is accepted. All bodies are strict; inherited HTTP size cap is 16 KiB.

| Method/path                             | Body / response                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST P                                  | `{operationKey,title,description,criteria,topicId,owner,reviewer,sourceMessageId,sourceEventId}` → 201 TaskResult |
| GET P                                   | `?limit=1..100&cursor=...` → `{items,nextCursor}`                                                                 |
| GET P/:taskId                           | Task DTO                                                                                                          |
| GET P/:taskId/history                   | Bounded page of immutable TaskEvent snapshots                                                                     |
| GET P/:taskId/executions                | Bounded page of immutable TaskExecution links                                                                     |
| POST P/:taskId/claim                    | Common command fields only                                                                                        |
| POST P/:taskId/progress                 | Common fields + `{note}`                                                                                          |
| POST P/:taskId/handoff                  | Common fields + `{recipient,mode:"work"\|"review",note}`                                                          |
| POST P/:taskId/request-review           | Common fields + `{reviewer,note}`                                                                                 |
| POST P/:taskId/review                   | Common fields + `{decision:"approve"\|"rework",note}`                                                             |
| POST P/:taskId/accept, /rework, /cancel | Common fields + `{note}`                                                                                          |
| POST P/:taskId/link-execution           | Common fields + `{reference,note}`                                                                                |

Common command fields are `{operationKey,expectedVersion}`; route supplies command type, so `type` in body is rejected. A member is `{kind:"human"|"agent",id:UUID}`; it denotes an assignment target, never authenticated caller identity. Required nullable create fields must be explicit `null` when absent. Title 1–160, description 0–4000, criteria 1–20 distinct nonempty strings of at most 500, notes 1–2000 characters. Topic and causal IDs must be accessible in the same channel. TaskResult is `{task,eventId,executionLink}`. Authorization failures use 401/403 or hidden-resource 404; invalid schemas/cursors 400, conflicting transitions/CAS/keys 409, oversized HTTP body 413. Errors omit payloads/internal diagnostics.

### Private client example

First run uses unchanged `npm run setup`, `npm start`, `npm run onboard`, then password login through a trusted private client. Read `/api/team` for IDs, create/enroll Developer and Reviewer through the existing agent/channel APIs. Keep the login JSON, cookie jar and issued token files outside the repository in a mode-0700 directory with mode-0600 files. Do not put passwords/tokens in command arguments or shell history. Example using an already prepared private cookie jar and JSON request file (replace paths/IDs locally):

```sh
curl --silent --show-error --fail \
  --cookie /private/kinmesh/owner.cookies \
  --header 'Content-Type: application/json' \
  --data-binary @/private/kinmesh/create-task.json \
  --output /private/kinmesh/task-result.json \
  http://127.0.0.1:3000/api/teams/TEAM_ID/channels/CHANNEL_ID/tasks
```

Example nonsecret request shape (replace assignment ID with an enrolled agent's UUID):

```json
{
  "operationKey": "task-create-001",
  "title": "Implement reviewed change",
  "description": "Keep execution and acceptance separate",
  "criteria": ["Independent review recorded", "Human checks delivered result"],
  "topicId": null,
  "owner": { "kind": "agent", "id": "00000000-0000-4000-8000-000000000001" },
  "reviewer": null,
  "sourceMessageId": null,
  "sourceEventId": null
}
```

For agent commands use `curl --header @/private/kinmesh/developer.headers` in place of cookies; the protected file contains the privately issued Authorization header. Never send both identities. Store responses privately too; task content is team data. Use same-origin HTTPS for remote deployment. No test fixture or T3 runtime is needed for this owner enrollment/API flow.

## Atomicity, replay and pagination

One immediate SQLite transaction rechecks credentials/membership, validates a receipt, performs SQL CAS on task ID/revision/prior status/owner, appends audit and shared outbox, and stores the response receipt. Claim additionally guards proposed status plus null owner. Independent processes compete at the database boundary; there is no JSON/PID lock or application retry loop. SQLite's configured bounded busy timeout applies; multi-host operation is unsupported.

Receipt scope is team + stable human/agent ID + action + target (channel for create, task for commands). The validated payload fingerprint includes expectedVersion. Exact replay with current authorization returns the original snapshot/event/link even after later revisions; it does not repeat effects. Different input under that key is 409; use a new key for a new revision/action. Grant rotation preserves stable agent identity but requires current scopes/membership. SQL triggers prohibit audit/link/receipt/outbox mutation and task contract edits/deletion; terminal states are immutable.

Task lists/history/links use existing position-based bounded snapshot cursors, ascending, default50/max100. They bind actor/team/channel/task/view, and recheck access on every page. Interleaved new inserts do not enter an existing snapshot or cause skips/duplicates. A task listing fixes the creation window, **not historical values**: statuses can change between pages. History is immutable; restart a scan for later events. No status filter or continuous stream is claimed.

`OutboxFact` extends existing communication facts with version-1 `TaskFact` (`task.changed`). Each fact has the same ID as its audit event, task ID/version/status/action, owner/reviewer, optional execution link ID, channel/topic, verified author/time, operation key and causal source IDs. Creation may reference an accessible message/event; later facts chain to the previous task event. Facts omit task text/criteria and retain common communication fields (`messageId:null`, etc.). Channel event reads and causal references filter task facts unless the principal currently has `tasks:read`. The separately deployed [Agent Inbox worker](agent-inbox.md) transactionally consumes relevant responsibility facts; task acceptance remains independent.

Execution links accept the existing strict bounded T3 ExecutionReference shape. Multiple links may attach to one task; duplicate native identity per task conflicts. These are caller-asserted associations, not verified live T3 evidence, run-state mirrors or a reason to accept. Runtime completion is absent from the transition algebra.

## Migration and evidence

Generated migration `0004_pale_thanos.sql` adds tasks, audit, reference links, composite foreign keys/indexes, CAS constraints and reviewed immutability triggers. Applied migrations are unchanged. No credentials/data are backfilled or broadened; populated #1–#4 identities, messages, grants and facts remain intact. Runtime applies migrations before listening. Back up the private DB/WAL before upgrade; no automated down migration is provided.

The local suite passes 93 tests (zero failures/skips). Tests cover real SQLite/Fastify full role flow, independent Node-process agent claim race (one winner/one conflict), actual HTTP child-server journey and restart, populated previous-schema upgrade, revoked/disabled access on every route, arbitrary humans/owners and mixed-identity denials, cross-team/channel hiding, all transition types, stable scoped replay/conflicts, multiple execution links, outbox/audit/receipt failure rollback, immutable SQL, pagination under interleaved writes and reopen recovery. The human in tests is an authenticated human account; no real owner product acceptance is inferred from the test.

Run `npm ci`, `npm run check`, `npm run format:check`, `npm run build`, `npm audit --omit=dev`; `npm run db:generate` must produce no schema drift. Tests require no private credentials. Existing mock T3 adapter contracts remain labeled; this feature does not run live T3 or browser E2E. Remaining gates: owner review, production/browser lifecycle, actual model evidence and full #9 collaboration acceptance. No UI, human invitation/recovery API, autonomous dispatch/wake, PR automation, task editing/deletion, acceptor reassignment or multi-node database is implemented.
