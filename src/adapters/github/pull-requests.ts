import { z } from 'zod';
import {
  CommitChecks,
  PullRequestObservation,
  Repository,
  commitChecks,
  type PullRequestRef,
} from '../../domain/pull-requests.js';
import { githubRequest } from './installations.js';

/** Where Kinmesh reads GitHub, and with what, if anything. */
export interface GitHubReader {
  /** GitHub's REST API origin; a stand-in's for tests. */
  api: string;
  /**
   * The team's GitHub credential for this read, or null to read public
   * repositories only, as an anonymous visitor would.
   */
  token: () => Promise<string | null>;
}
/** Asks GitHub about one pull request; never throws. */
export type ReadPullRequest = (
  ref: PullRequestRef,
  signal: AbortSignal,
) => Promise<PullRequestObservation>;

const Answer = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable(),
  html_url: z.url(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({
    ref: z.string(),
    repo: z.object({ full_name: Repository }),
  }),
});

const CheckRuns = z.object({
  check_runs: z.array(
    z.object({ status: z.string(), conclusion: z.string().nullable() }),
  ),
});
const Statuses = z.object({
  statuses: z.array(z.object({ state: z.string() })),
});
/** A check run's end, as Kinmesh counts it. */
const runOutcome = (run: { status: string; conclusion: string | null }) =>
  run.status !== 'completed' || run.conclusion === null
    ? ('pending' as const)
    : ['success', 'neutral', 'skipped'].includes(run.conclusion)
      ? ('passed' as const)
      : ('failed' as const);
/** A commit status's end, as Kinmesh counts it. */
const statusOutcome = (status: { state: string }) =>
  status.state === 'success'
    ? ('passed' as const)
    : status.state === 'pending'
      ? ('pending' as const)
      : ('failed' as const);
type Refusal = 'not-found' | 'forbidden' | 'rate-limited' | 'unreachable';

/**
 * Reads pull requests from GitHub's REST API: the one address the
 * repository and number name, never one a person gave, and the checks and
 * statuses of its head commit.
 */
export function githubPullRequests(reader: GitHubReader): ReadPullRequest {
  return async (ref, signal) => {
    // Without one (not connected, or GitHub refused to mint one), read as
    // an anonymous visitor would.
    const token = (await reader.token().catch(() => null)) ?? '';
    const [owner = '', name = ''] = ref.repository.split('/');
    const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    /** One GitHub answer as JSON, or why there is none. */
    const get = async (
      path: string,
    ): Promise<{ refused: Refusal } | { json: unknown }> => {
      let response: Awaited<ReturnType<typeof githubRequest>>;
      try {
        response = await githubRequest(reader.api, repo + path, {
          authorization: token ? `Bearer ${token}` : null,
          signal,
        });
      } catch {
        return { refused: 'unreachable' };
      }
      if (response.status === 404) return { refused: 'not-found' };
      if (
        (response.status === 403 || response.status === 429) &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after'))
      )
        return { refused: 'rate-limited' };
      if (response.status === 401 || response.status === 403)
        return { refused: 'forbidden' };
      if (response.status >= 300) return { refused: 'unreachable' };
      return { json: response.json };
    };
    const refusal = (answer: { refused: Refusal } | { json: unknown }) =>
      'refused' in answer ? answer.refused : null;
    const body = (answer: { refused: Refusal } | { json: unknown }) =>
      'json' in answer ? answer.json : null;
    const at = () => new Date().toISOString();
    const unavailable = (reason: Refusal) =>
      PullRequestObservation.parse({
        kind: 'unavailable',
        reason,
        observedAt: at(),
      });

    const read = await get(`/pulls/${String(ref.number)}`);
    const refused = refusal(read);
    if (refused !== null) return unavailable(refused);
    const answer = Answer.safeParse(body(read));
    if (!answer.success) return unavailable('unreachable');
    const pull = answer.data;
    const checks = await commitChecksOf(pull.head.sha);
    const observed = PullRequestObservation.safeParse({
      kind: 'observed',
      repository: pull.base.repo.full_name,
      number: pull.number,
      title: pull.title.slice(0, 1024),
      state:
        pull.merged_at !== null
          ? 'merged'
          : pull.state === 'open'
            ? 'open'
            : 'closed',
      draft: pull.draft ?? false,
      url: pull.html_url,
      headRef: pull.head.ref.slice(0, 256),
      headSha: pull.head.sha,
      baseRef: pull.base.ref.slice(0, 256),
      checks,
      observedAt: at(),
    });
    return observed.success ? observed.data : unavailable('unreachable');

    /** The head commit's check runs and statuses, summed. */
    async function commitChecksOf(sha: string): Promise<CommitChecks | null> {
      if (!/^[0-9a-f]{40}$/.test(sha)) return null;
      const [runs, statuses] = await Promise.all([
        get(`/commits/${sha}/check-runs?per_page=100`),
        get(`/commits/${sha}/status?per_page=100`),
      ]);
      const failed = refusal(runs) ?? refusal(statuses);
      if (failed !== null)
        return CommitChecks.parse({
          kind: 'unavailable',
          sha,
          // A commit of a readable pull request that GitHub hides is a
          // permission Kinmesh's credential lacks.
          reason: failed === 'not-found' ? 'forbidden' : failed,
          observedAt: at(),
        });
      const r = CheckRuns.safeParse(body(runs));
      const st = Statuses.safeParse(body(statuses));
      if (!r.success || !st.success)
        return CommitChecks.parse({
          kind: 'unavailable',
          sha,
          reason: 'unreachable',
          observedAt: at(),
        });
      return commitChecks(
        sha,
        [
          ...r.data.check_runs.map(runOutcome),
          ...st.data.statuses.map(statusOutcome),
        ],
        at(),
      );
    }
  };
}
