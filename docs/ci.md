# CI and complete native collaboration

Kinmesh has two different gates. A green code gate alone is not evidence of real model integration.

| Gate                 | Trigger                                       | Authority and execution                                                                                         | Required result                                                                   |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `CI`                 | Pull requests to `main`, and pushes to `main` | No model credentials; strict checks, real SQLite/process tests, genuine Chromium; native DTO cases use fixtures | `foundation` and `chromium` pass on the reviewed revision                         |
| `Live collaboration` | Explicit dispatch on `main`                   | GitHub-hosted disposable Linux VM per executor, Environment `live`, real T3/Codex or T3/Grok                    | Both executor jobs pass, including cleanup; evidence identifies the tested commit |

The live workflow uses Actions Environment Secrets `LLM_API_KEY`, `CODEX_BASE_URL` and `GROK_BASE_URL`. The Environment allows only the `main` branch. Secrets are supplied only to the integration step, not dependency installation or ordinary PR jobs. Endpoint settings are generated at runtime. Base64 is not encryption and is not required. Neither provider configuration files nor private OAuth credentials belong in Git or artifacts.

`main` requires current `foundation` and `chromium` checks through pull requests. The manual live gate is a release requirement, rather than a required PR status that cannot run on an unmerged fork. A release must use successful native evidence for its exact source commit; a previous green run does not approve later changes.

## Native dependencies and isolation

The runner installs T3 **0.1.5** (release SHA-256 verified), Codex **0.166.0**, and Grok **1.0.70**. It checks real executables rather than using `login status` as proof of model access. The model combinations are Codex `gpt-6.1-sol` and Grok `grok-4.7`.

Each matrix job creates its own T3 state, Kinmesh database, channel, Human account, Agent profiles, role-specific Provider homes, Team MCP listener and browser context. Provider instances are configured through native T3 settings. Real native consent issues separate Read only and Supervised OAuth grants. Kinmesh uses the official external OAuth/MCP interface for execution and authoritative reads. Providers use the actual authenticated Team MCP server for team operations. No direct-model fallback, shared owner desktop state or private T3 storage/API is used.

T3 and Kinmesh run on the same disposable VM with protected loopback MCP endpoints. This proves the MCP contract and full workflow; it does not establish remote HTTPS routing, tunnel availability or cross-host deployment. Those deployment properties require their own topology checks. The model endpoints remain HTTPS.

## Complete collaboration contract

Both executors must complete the entire sequence. A partial scenario or an assistant saying it completed work is insufficient.

1. Use the browser to bootstrap an Owner, sign in, create a channel, register and enroll distinct Developer and Reviewer Agents, and create a task with acceptance criteria and both assignments.
2. Verify native Provider capability/model readiness and distinct Read only/Supervised grants. A native mutation attempted with Read only must be denied by T3.
3. Start the product with normal `npm start` and Inbox configuration. The task event must launch the Developer automatically. The Developer reads Team MCP context, publishes an actual artifact, and hands off the current task version to the Reviewer. The Reviewer reads the artifact and decision history independently, publishes a review, and requests Human acceptance.
4. During the first native execution, kill the actual supervised Worker while it holds a live lease. A competing claim must fail. Normal supervision must restart the Worker; after the real lease expires, the existing delivery must settle with its original stable native request and result. Do not shorten or edit production lease timestamps.
5. Replay the original task submission and verify it does not create more deliveries. Attempt Human acceptance with an Agent Bearer and a spoofed Human header; it must be denied and leave the task awaiting Human.
6. Stop only the disposable T3 service. Use the browser to request rework requiring a second artifact that keeps the marker and arithmetic and adds `verified`. The queued work must retain its identity without a result while T3 is unavailable. Restart the same T3 state. Both Agents must execute a second cycle, ending at `awaiting-human` again.
7. Independently match every Inbox delivery, source event, Agent author, execution journal, exact native Thread/Run, actual Assistant item, published result and task execution link. Verify four distinct original native requests and results, and inspect actual Team MCP calls for both roles.
8. Restart Kinmesh and verify persisted task/execution history. Use the browser to accept the second artifact. Check the distinct Human rework and acceptance events and task version. Native execution success and Reviewer approval must never perform Human acceptance.
9. Use the real AG-UI native observer and Read only OAuth, follow the exact T3-returned verified thread link, and check desktop/mobile layouts. Deny cross-channel Team MCP reads and deny access with a revoked Agent grant.
10. Revoke both test Agent grants, verify denial, stop owned process groups, and verify cleanup. Cleanup failure fails the gate. Publish only bounded redacted evidence.

The CI Human is an authenticated **simulated Human test account**. Its decisions test product permissions and persistence; they are not a real person's product acceptance or release approval. Native Supervised approvals are inspected and limited to the disposable channel/task and expected operation. Session-wide approval and Full access are not used.

## Fault coverage and evidence limits

This scenario includes duplicate-source delivery, concurrent claim fencing, actual Worker death after launch, service unavailability, stateful restart and permission revocation. Ordinary tests separately exercise lost replies, exact older-Run settlement, causality limits and native terminal/uncertain states using explicit fixtures. Those fixture tests must not be reported as new live fault-injection evidence. The historical [v0.1 report](acceptance/v01-workflow-2026-10-31.md) remains a separate, revision-specific record.

Every stage fails on unexpected state, blocked work, wrong authority, wrong Run/model, missing real output or incomplete cleanup. Real uncertainty must remain investigable. There is no test retry. Planned normal cost is **four native model Runs per executor**, eight across the matrix; failures can leave fewer completed Runs. Retries after an identified repair are new, separately recorded invocations and can incur more cost. No exact monetary bound is inferred from output length.

Only `.live-evidence/*.json` is uploaded, with source commit, dependency/model identity, checked outcomes, hashed correlations, failure stage and cleanup state. Logs, prompts, tool payloads, browser recordings, tokens and private databases are excluded. Tracing, video and screenshots are disabled. Failed local state remains in its private temporary directory for investigation; successful state is removed after cleanup. GitHub runner state disappears with the disposable VM.

## Execute and diagnose

Ordinary checks:

```sh
npm ci
npm run check
npm run format:check
npm run build
npm audit --omit=dev
npx playwright install --with-deps chromium
npm run test:browser
```

Dispatch real integration for reviewed `main`:

```sh
gh workflow run live.yml --ref main
```

For a trusted local runner, use Node 24, the same three secret environment variables, `KINMESH_LIVE_EXECUTOR=codex` or `grok`, and absolute `KINMESH_T3_BINARY`, `KINMESH_CODEX_BINARY`, `KINMESH_GROK_BINARY` paths. After installing Chromium and building, run `npm run test:collaboration-live`. The OAuth callback port `127.0.0.1:49871` must be free. Do not run jobs concurrently on the same machine, reuse another gate's consumed fixture, or run the test inside a directory with an unrelated `.env` file.

On failure, inspect the redacted artifact and exact source revision first. Use the private native state through official MCP/UI to identify the real cause. Do not delete journals, change operation keys, weaken assertions or repeatedly dispatch merely to obtain green output. Fix the responsible layer, review the change, and execute a new gate for that revision. A failed job and its partial native executions remain part of the acceptance record.
