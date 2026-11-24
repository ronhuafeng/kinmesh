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
  /** Open, or not yet read: it may change at any moment. */
  open: 5 * 60_000,
  /** Merged or closed: it rarely changes again. */
  settled: 6 * 60 * 60_000,
};
const settled = (o: PullRequestObservation) =>
  o.kind === 'observed' && o.state !== 'open';
/** How long after an observation Kinmesh should ask GitHub again. */
export const askAgainAfter = (o: PullRequestObservation) =>
  settled(o) ? PULL_REQUEST_FRESH_MS.settled : PULL_REQUEST_FRESH_MS.open;
/**
 * An answer older than three of its asking intervals: GitHub has not been
 * reachable since, so it may no longer be true.
 */
export const pullRequestStale = (o: PullRequestObservation, now: number) =>
  now - Date.parse(o.observedAt) > 3 * askAgainAfter(o);
/** How many pull requests one task may link. */
export const TASK_PULL_REQUESTS_MOST = 20;
