import { z } from 'zod';
import { TaskId } from './contracts.js';
import { Author } from './agents.js';

/** `owner/name` of a GitHub repository, as GitHub allows them. */
export const Repository = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1] ?? ''));
/** A pull request as someone names it: which repository, which number. */
export const PullRequestRef = z.strictObject({
  repository: Repository,
  number: z.number().int().positive().max(2_147_483_647),
});
export type PullRequestRef = z.infer<typeof PullRequestRef>;
/** One pull request, however its repository's name is cased. */
export const pullRequestKey = (ref: PullRequestRef) =>
  `${ref.repository.toLowerCase()}#${String(ref.number)}`;
/**
 * The pull request a GitHub address names, such as
 * `https://github.com/owner/name/pull/12/files`; null for anything else.
 * Kinmesh never fetches the address: it only reads which pull request it is.
 */
export function pullRequestFromUrl(text: string): PullRequestRef | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  const [owner, name, pull, number] = url.pathname.split('/').slice(1);
  if (pull !== 'pull' || !owner || !name || !number || !/^\d+$/.test(number))
    return null;
  const parsed = PullRequestRef.safeParse({
    repository: `${owner}/${name}`,
    number: Number(number),
  });
  return parsed.success ? parsed.data : null;
}
/**
 * Each check and status GitHub reports for a commit, as one of three: it
 * passed (success, or neutral or skipped), it failed (any other end), or it
 * has not ended. A check run superseded by a newer one of the same name is
 * GitHub's to drop; Kinmesh counts what GitHub lists.
 */
export const CheckOutcome = z.enum(['passed', 'failed', 'pending']);
export type CheckOutcome = z.infer<typeof CheckOutcome>;
/**
 * The checks of one commit, the pull request's head when they were read:
 * `failing` if any failed, else `pending` if any has not ended, else
 * `passing`; `none` when the commit has none, which is not a pass.
 * `unavailable` when GitHub would not say (no permission, a limit, an
 * outage).
 */
export const CommitChecks = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('observed'),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    state: z.enum(['passing', 'failing', 'pending', 'none']),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    observedAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    reason: z.enum(['forbidden', 'rate-limited', 'unreachable']),
    observedAt: z.iso.datetime(),
  }),
]);
export type CommitChecks = z.infer<typeof CommitChecks>;
/** The checks of a commit, summed from each one's outcome. */
export function commitChecks(
  sha: string,
  outcomes: CheckOutcome[],
  observedAt: string,
): CommitChecks {
  const count = (o: CheckOutcome) => outcomes.filter((v) => v === o).length;
  const [passed, failed, pending] = [
    count('passed'),
    count('failed'),
    count('pending'),
  ];
  return CommitChecks.parse({
    kind: 'observed',
    sha,
    state:
      failed > 0
        ? 'failing'
        : pending > 0
          ? 'pending'
          : passed > 0
            ? 'passing'
            : 'none',
    passed,
    failed,
    pending,
    observedAt,
  });
}
/**
 * What GitHub said about a pull request when Kinmesh last asked, and when.
 * `unavailable` says why it could not be read: GitHub has no such pull
 * request or will not show it to Kinmesh (`not-found`), refused Kinmesh's
 * credential (`forbidden`), limited how often Kinmesh may ask
 * (`rate-limited`), or could not be reached (`unreachable`). Nothing here
 * says the pull request was reviewed or that its work is right.
 */
export const PullRequestObservation = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('observed'),
    /** The repository as GitHub names it now. */
    repository: Repository,
    number: PullRequestRef.shape.number,
    title: z.string().max(1024),
    state: z.enum(['open', 'closed', 'merged']),
    draft: z.boolean(),
    url: z.url(),
    headRef: z.string().max(256),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseRef: z.string().max(256),
    /**
     * The checks of `headSha`, read with it; null when not read (kept from
     * before Kinmesh read checks). A new head is read with its own.
     */
    checks: CommitChecks.nullable().default(null),
    observedAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.enum(['not-found', 'forbidden', 'rate-limited', 'unreachable']),
    observedAt: z.iso.datetime(),
  }),
]);
export type PullRequestObservation = z.infer<typeof PullRequestObservation>;
/**
 * A pull request linked to a task: who said it belongs to the task, and
 * when. The link is the linker's claim; it never changes.
 */
export const TaskPullRequest = z.strictObject({
  id: z.uuid(),
  position: z.number().int().positive(),
  taskId: TaskId,
  pullRequest: PullRequestRef,
  author: Author,
  createdAt: z.iso.datetime(),
});
export type TaskPullRequest = z.infer<typeof TaskPullRequest>;
/** A linked pull request with what GitHub last said; null until it is read. */
export const TaskPullRequestView = TaskPullRequest.extend({
  observation: PullRequestObservation.nullable(),
});
export type TaskPullRequestView = z.infer<typeof TaskPullRequestView>;
/** How soon Kinmesh asks GitHub again about a pull request, by its state. */
export const PULL_REQUEST_FRESH_MS = {
  /** Its checks are running: they end within minutes. */
  checking: 60_000,
  /** Open, or not yet read: it may change at any moment. */
  open: 5 * 60_000,
  /** Merged or closed: it rarely changes again. */
  settled: 6 * 60 * 60_000,
};
/** How long after an observation Kinmesh should ask GitHub again. */
export const askAgainAfter = (o: PullRequestObservation) =>
  o.kind !== 'observed'
    ? PULL_REQUEST_FRESH_MS.open
    : o.checks?.kind === 'observed' && o.checks.state === 'pending'
      ? PULL_REQUEST_FRESH_MS.checking
      : o.state !== 'open'
        ? PULL_REQUEST_FRESH_MS.settled
        : PULL_REQUEST_FRESH_MS.open;
/**
 * An answer older than three of its asking intervals: GitHub has not been
 * reachable since, so it may no longer be true.
 */
export const pullRequestStale = (o: PullRequestObservation, now: number) =>
  now - Date.parse(o.observedAt) > 3 * askAgainAfter(o);
/** How many pull requests one task may link. */
export const TASK_PULL_REQUESTS_MOST = 20;
