# ADR 0006: Owners recover blocked deliveries from the workspace

Status: implemented (#62). Amends the "local administration only" rule for `resume` in [Agent Inbox](../agent-inbox.md).

A blocked delivery used to carry one reason, `authority-or-contract-blocked`, and could only be resumed from a terminal on the worker machine. The person who asked could see that something was stuck but not why, and could not act on it.

Decision:

- **Record the cause.** When a delivery blocks, the worker records the first Kinmesh precondition it no longer meets: `agent-disabled`, `credential-invalid` (revoked, expired or missing a needed scope), `not-in-channel` or `not-assigned`. For T3 failures it records `native-access` (permission or authentication) or `native-incompatible` (contract, conflict, invalid input, or a binding/profile mismatch). The diagnosis only reads state and never grants anything. Rows recorded before this change keep the old reason, which is shown as an unknown cause.
- **Let owners resume.** `POST /api/teams/:teamId/deliveries/:deliveryId/resume` takes an operation key and is available only to a human who owns the team and can read the delivery's channel. Agent bearers are denied whatever their scopes. Retrying with the same key replays the first result.
- **Keep every resume invariant.** Owner resume and the operator CLI share the same transition: only a `blocked` row whose lease has expired can be reopened. It keeps the frozen intent, authority and native request key, and dispatch and publication recheck authority as before, so a resume cannot bypass a revoked grant or switch authority. A cause that still holds blocks the delivery again with the same reason. The history records `owner-resume` or `operator-resume`.

The workspace pairs each cause with one action. It re-enables the agent or adds it back to the channel and then retries, or it opens the agent's setup next to a plain **Retry**. A lost assignment offers no retry. The operator CLI stays for unknown causes.
