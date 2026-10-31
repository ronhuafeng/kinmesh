# CI and owner-native acceptance

Credential-free code checks and owner-native acceptance have separate authority.

| Gate                          | Trigger                                             | Authority and result                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI`                          | Pull requests to `main`, and all branch pushes      | Separate `foundation` and `chromium` jobs check the exact revision without native or model credentials. A topic-branch push and its PR each run both jobs. Native DTO/oracle cases are fixtures.                                |
| `Live collaboration`          | Manual dispatch                                     | **Blocked: `approval-required`.** Its first executable step rejects every ref except `refs/heads/main`. Main then fails before checkout, npm, native installation or secret-bearing execution. No native acceptance is claimed. |
| `Authenticated T3 acceptance` | Owner-authorized manual dispatch on reviewed `main` | Existing dedicated owner-runner workflow and `release:check`; see [release preparation](release-check.md). The owner must personally provide native consent and individual approvals.                                           |

## Owner consent boundary

The unattended collaboration harness previously selected native Read only/Supervised OAuth consent, clicked Authorize/Allow, and clicked native pending-tool Approve. These automated decisions cannot establish the human owner's consent. The harness now fails with `approval-required` before setup, and its OAuth and pending-approval paths cannot click consent or approval controls. Runner entry points also reject Provider configuration, native startup/pairing and Provider setup when `GITHUB_ACTIONS` is present. There is no approval flag, relay, environment-reviewer substitute or skipped pass.

The workflow binds no model secrets. Its main-ref guard executes before any repository code, and its next step deliberately exits nonzero. GitHub Environment restrictions and review settings are additional controls, not the executable safety gate. A dispatch of this workflow currently cannot succeed. Do not dispatch it for acceptance or retry the failed paid run.

The harness's CI Human account simulates product task creation, rework and acceptance. Those actions test Kinmesh permissions and persistence. They never grant T3 owner-native OAuth consent, individual native `approval-required` tool approval, human product acceptance or release signoff. Native Supervised authority must remain `approval-required`; no automatic approval or Full access is authorized.

A genuine owner-operated consent/approval path has not been implemented for the disposable GitHub runner. Removing the block requires a separately reviewed implementation with actual owner-operated native consent and exact Run/request approval correlation. Re-enabling the old clicks, setting a flag, approving a GitHub Environment or relabeling the simulated Human does not satisfy that requirement. Until then use only the existing, separately authorized [owner-manual path](release-check.md), with private owner-issued grants, isolated Providers and deliberate individual native approvals. Code CI does not authorize running that path.

## Evidence and limitations

[Issue #9](https://github.com/ronhuafeng/kinmesh/issues/9) remains open. The prior [native run 41187016509](https://github.com/ronhuafeng/kinmesh/actions/runs/41187016509) failed both matrix jobs and published zero artifacts; it is not a release pass. The [AI source review](https://github.com/ronhuafeng/kinmesh/pull/42#pullrequestreview-5722134795) identifies the owner-consent and pre-checkout ref defects. An AI comment is not human approval.

PR #46's persisted, read-back-verified `GROK_MAX_MCP_OUTPUT_BYTES=131072` Provider override remains in source: its pinned ACP execution had clipped the second review history at 20,000 bytes despite the user config size setting. Preserving that repair does not authorize native execution or establish that its live acceptance passed.

PR #45's `.live-evidence/*.json`, `include-hidden-files: true`, retention and missing-file failure settings remain intact. Its native activity cursor and diagnostics changes remain intact. A blocked dispatch creates no native state or evidence; the upload step is gated on the owner-approval step succeeding, so it cannot upload stale evidence or replace the explicit failure with an artifact error. No new native artifact path repair is required. No native evidence upload was exercised by this code-only remediation.

Private logs, Provider homes/configuration, OAuth grants, tokens, callback/one-time URLs, tool payloads, browser state and databases must never enter public logs, issues, PRs or artifacts. Local safety tests use synthetic canaries and page/process traps without contacting T3 or any Provider. They are source-safety evidence, never live native PASS. The [historical v0.1 report](acceptance/v01-workflow-2026-10-31.md) keeps its original revision-specific scope.

## Credential-free verification

```sh
npm ci
npm run check
npm run format:check
npm run build
npm audit --omit=dev
npx playwright install --with-deps chromium
npm run test:browser
```

These commands exercise strict types, lint, local SQLite/process tests, architecture and real Chromium against Kinmesh. Browser native DTO cases remain fixtures. Do not run `test:collaboration-live`, `release:check`, `t3:auth`, model/Provider commands or native workflows as part of code-only verification.
