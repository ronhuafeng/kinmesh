# ADR 0004: Durable responsibility, technical review and human acceptance

Status: implemented for Issue #5; owner review pending.

A task is a Kinmesh-owned acceptance contract, independent of AgentId lifecycle and T3 execution state. Reuse → Adapt → Extend → Build: reuse verified principals/channel enrollment, strict Zod schemas, Drizzle and SQLite WAL; extract existing transaction/receipt/pagination helpers instead of adding infrastructure. Introduce only task state, decisions and external reference associations. No new dependencies or execution engine.

A discriminated state algebra controls transitions; live repository authorization and SQL CAS guard every command in one immediate transaction. A claim requires the expected revision, proposed status and null owner. Persist task, immutable audit, shared versioned outbox fact and operation receipt atomically. Receipt scope is stable actor/team/action/target; exact retries recover the original result, changed payloads conflict. Authorization precedes replay.

Keep work responsibility through reviewer handoff. Technical approval is explicitly different from acceptance: only a designated human team owner, still joined to the channel, may accept after review. The designated human may rework/cancel, or recover a disabled owner's unfinished task through an explicit audited work transfer that clears review. Neither a descriptive agent role, provider turn nor any arbitrary human participant grants this authority.

Persist multiple immutable external execution links as caller-asserted evidence references. Do not mirror authoritative T3 status or infer completion. Task facts join the existing outbox but require task read scope; there is no worker/delivery claim. See [policy, API and evidence](../tasks.md).
