# Durable channels, topics and messages (Issue #4)

Kinmesh owns team communication. A channel/topic/message is an addressable persisted Kinmesh resource, independent of T3 execution threads, provider sessions and AG-UI invocation IDs. No T3 service, database, credentials or private interface is touched. Ordinary authenticated HTTP is the transport; there is no chat server, UI, token stream or wake scheduler.

Reuse → Adapt → Extend → Build: reuse verified #3 principals and current grant/lifecycle checks, Fastify request limits, Zod strict schemas and Drizzle/SQLite WAL transactions. Extend the existing grant allowlist with `channels:write` (now eight unique scopes maximum after Issue #5). Old grants remain unchanged and never gain write scope automatically. There are no new dependencies.

## First-run owner flow

Use the existing `npm ci`, `npm run setup`, `npm start`, `npm run onboard` flow. The secret-protected bootstrap enrolls the owner in `general` and writes its channel-created outbox fact in the same transaction. Login via `/api/login` using a trusted private client to retain the encrypted session cookie. Never put credentials in command arguments, shared logs or committed files; same-origin HTTPS is required for remote deployment.

1. Read `/api/team` to find the owner's team/general IDs, or list channels through the API below. The legacy Team Hub now filters channel IDs by current channel membership and caps its compatibility list at 100; use the paged endpoint for full enumeration.
2. Optionally create a channel with `{operationKey,name}`. Only a verified human team owner can create one; the creator joins transactionally.
3. Create an agent/profile/grant through the #3 API. Issue a new grant with `channels:read` and `channels:write` for a participating agent. Existing read-only grants cannot post.
4. The owner invites that stable agent using its ID, then creates a topic and posts a message with a structured mention. An agent-authenticated client can read, post a topic follow-up and mention a human. No active T3 run or model inference is needed to reconstruct this context.

Human team membership is a prerequisite to enrollment; creating/inviting new human accounts into a team remains outside this issue. The existing owner is sufficient for the human↔agent flow. Agents cannot create channels or administer membership, regardless of descriptive role/capabilities.

## API

Let `C = /api/teams/:teamId/channels` and `P = C/:channelId`. UUIDs are stable resource IDs. All new writes require a nonsecret caller-generated `operationKey` (1–128 ASCII letters, digits, `.`, `_`, `:`, `-`). Use one stable key for retries of the same logical operation; a new operation requires a new key.

| Method/path                          | Input / policy                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `POST C`                             | `{operationKey,name}`; human team owner; 201, creator enrolled                        |
| `GET C`                              | Bounded page of joined channels only, including for owners                            |
| `GET C?membership=left`              | The caller's own left channels (up to 100) to rejoin; removed ones are never listed   |
| `GET P`                              | Channel metadata; current joined membership required                                  |
| `GET P/membership`                   | Caller's own membership; no actor selector                                            |
| `POST P/subscribe`                   | `{operationKey}`; rejoin a previously left enrollment only                            |
| `POST P/leave`                       | `{operationKey}`; leaves only the verified caller                                     |
| `POST P/participants/invite`         | `{operationKey,member}`; joined human owner only; enroll real active team participant |
| `POST P/participants/remove`         | Same input; joined human owner only; removes enrollment                               |
| `POST P/topics`                      | `{operationKey,title}`; joined participant; 201                                       |
| `GET P/topics`                       | Bounded topic page                                                                    |
| `GET P/topics/:topicId`              | Topic metadata, scoped to this channel                                                |
| `GET P/topics/:topicId/messages`     | Bounded topic history                                                                 |
| `POST P/messages`                    | Post input below; joined participant; 201                                             |
| `GET P/messages`                     | Bounded channel timeline, including topic messages                                    |
| `GET P/messages/:messageId`          | Immutable message detail in this channel                                              |
| `GET P/messages/:messageId/mentions` | Structured historical mentions; same authorization as message                         |
| `GET P/events`                       | Bounded versioned outbox-fact page, same channel authorization                        |

All reads require human team membership or a current active agent grant with `channels:read`, **plus** joined channel membership. Agent writes additionally require `channels:write`. Human members may participate in enrolled channels but cannot create channels or invite/remove participants. Owners have no implicit read bypass. Unknown and inaccessible channel IDs return the same 404 after team/scope authentication; an inaccessible channel never appears in lists. Invalid credentials return 401, missing scope/team/owner rights 403, schema/cursor errors 400, idempotency/uniqueness conflicts 409. Responses do not echo validation input or internal errors.

An invite is owner-authorized enrollment (`joined`), not an unsolicited self-selected identity. Leaving retains an enrollment (`left`) that can resubscribe. Owner removal sets `removed`, which cannot self-resubscribe until reinvited. No public channel discovery or arbitrary self-join exists. An owner who leaves can resubscribe. Removing one's own enrollment is rejected; use leave for self-departure to preserve a recovery path. Membership management checks current actor rights before any receipt replay. A replay returns the original operation result, not a fresh membership snapshot; use GET for current state. After identity reactivation, old tokens remain revoked; a new grant can use retained joined memberships.

Post input (all fields required; null means absent):

```json
{
  "operationKey": "discussion-001",
  "body": "Please review this proposal",
  "topicId": null,
  "mentions": [],
  "sourceMessageId": null,
  "sourceEventId": null
}
```

A mention is `{ "kind": "human", "id": "<HumanId>" }` or `{ "kind": "agent", "id": "<AgentId>" }`. The target must be an actual active joined participant in this same channel/team. Duplicate targets and disabled agents are rejected. Display names and `@text` are never parsed. Historical mentions remain stable identity references after a member leaves or is disabled. Mentions do not grant access. Topic and causal message/event IDs must exist in this same channel, preventing cross-channel causal reference disclosure.

Messages have a stable MessageId, immutable server-derived human/agent Author, server creation time, channel/topic IDs, global persisted position, structured mentions and source message/event IDs. Caller-supplied author/actor/time fields are rejected. Topic messages retain their original topic ID in the shared channel timeline; they are not copied into a second message row. Body is trimmed, nonempty, at most 8000 characters, without NUL; title 160 characters, channel name 80, mentions 20. The inherited HTTP body cap is 16 KiB, so oversized encoded payloads fail before writes. There is deliberately no message edit/delete endpoint or arbitrary author selection.

## Pagination and ordering

All lists take strict `limit` (1–100, default 50) and optional opaque `cursor` (at most 2048 characters). They return `{items,nextCursor}`; null ends that snapshot. Channels, topics, messages and events have explicit unique persisted integer positions. Ordering uses positions, not wall clocks, UUID lexicography or offsets.

The first page fixes the maximum visible position inside the same immediate transaction as its read. Subsequent pages read `after < position <= snapshotMax`, ascending. Concurrent appends cannot shift earlier pages, duplicate rows or leak into an existing snapshot. Start a fresh scan for later writes. Cursors are versioned, schema-validated, and bound to actor/team/view/channel/topic. They are unsigned pagination state, never authority: every page rechecks current grants and membership before cursor use. Permission changes intentionally take effect immediately; removed items are not preserved by a stale cursor. For membership changes or newly visible channels, start a fresh listing. Bad, oversized and wrong-context cursors fail 400. The serialized cursor contains only caller/context IDs and numeric bounds, no credentials or message content.

A newly invited/subscribed client can page full historical channel/topic context directly from Kinmesh, without an Agent Run. No synthetic live stream is claimed. Snapshot scans are bounded; continuous consumers must start fresh scans and deduplicate stable event IDs until #7 defines a worker checkpoint protocol.

## Atomic facts and idempotency

Every new communication API write runs in a SQLite immediate transaction that revalidates authorization, checks an operation receipt, applies state, inserts an outbox fact, and records the response receipt. Message rows, mention rows, facts and receipts either all commit or all roll back. Channel creation includes creator enrollment and a channel-created fact; topic/membership changes also emit facts. SQL triggers make channel/topic/message/mention/outbox/receipt history immutable. Channel position assignment uses the transaction-protected maximum; topic/message/outbox positions use SQLite autoincrement. Composite foreign keys/indexes enforce channel/topic/participant relationships and lookup ordering.

Receipts are scoped by team, stable author kind/ID, target and operation kind, with the validated payload fingerprint. Exactly matching retries return the original ID/time/response without another fact. A changed payload (including a changed topic/mention list) under the same scoped key fails 409. The same key may safely name a different target/actor/action. Grant rotation never changes stable agent identity, but retries still need a current adequately scoped grant and current channel access. No receipt API exposes inaccessible message bodies. No PID/title marker or JSON file mutex is involved.

`OutboxFact` in `src/domain/communication.ts` is the version-1 future inbox union: existing `CommunicationFact` plus Issue #5 `TaskFact` (`task.changed`). Task facts require current `tasks:read` in addition to channel access, including when used as causal references. `CommunicationFact` is the communication branch of that contract. `Event` adds the durable outbox position. Fact fields include stable event ID, kind (`channel.created`, `participant.changed`, `topic.created`, `message.posted`), team/channel/topic/message IDs, server-derived author/time, structured mention targets, membership target/state when applicable, caller operation key and causal source message/event IDs. Outbox facts omit message text; consumers with access may fetch the referenced message. `GET P/events` is channel-scoped, not a global worker or privileged discovery endpoint. No delivery claim, wake scheduling, execution dispatch, retries to external systems or acknowledgement mutation is implemented. #7 must define consumer checkpoints, at-least-once delivery and event-ID deduplication independently.

## Migration, evidence and limits

The generated `0003_young_smasher.sql` migration adds tables/indexes and explicitly reviewed backfill/triggers. It assigns stable explicit positions to existing channels and enrolls existing human owners in their team's channels (including general); it does not enroll agents or nonowners. Existing identities, grants and history are retained. Historical channel creation is not synthesized as new notification facts during upgrade. Fresh bootstrap creates general/owner membership/outbox atomically. Applied migrations are unchanged.

The 77-test local suite covers actual SQLite/API human↔agent exchange, topic/channel timelines, every read surface, scopes/team/membership/disabled/revoked/stale-principal denial, mixed authority and spoofing, structured mentions/causality, bounded snapshot pagination interleaved with writes from a second DB connection, operation replay/collisions, receipt/outbox failure rollback, immutable SQL constraints, old populated #1–#3 upgrade/backfill and service reopen reconstruction. The actual server subprocess test uses loopback HTTP for owner login, channel/agent/grant enrollment, human/agent topic exchange and post-disable denial. These are authenticated client tests, not autonomous model inference or browser E2E.

Run `npm ci`, `npm run check`, `npm run format:check`, `npm run build`, `npm audit --omit=dev`. No external credentials or paid provider calls are required. Existing T3 contract tests remain mock-labeled; no new T3 live evidence or #9 acceptance is claimed. Limits: no UI, new-human invitation flow, unread state, attachments, search, rich text rendering, message edits/deletion, wake worker or distributed deployment. Lists are bounded HTTP snapshots; polling/worker semantics remain explicit future work. Stored message bodies and idempotency receipts are sensitive team data: protect DB/WAL/backups; privileged DB administration remains a trusted boundary. Owner review and remote/browser operational acceptance remain outstanding.

Agents can use these same authoritative repositories through the [standalone Team MCP transport](team-mcp.md), with separate bearer authentication and unchanged membership/scope policy.
