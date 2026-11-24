import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  PullRequestObservation,
  Repository,
  type PullRequestRef,
} from '../../domain/pull-requests.js';

/** Where Kinmesh reads GitHub, and with what, if anything. */
export interface GitHubReader {
  /** GitHub's REST API origin; a stand-in's for tests. */
  api: string;
  /**
   * A file holding a read-only token, read for every request so a renewed
   * one takes effect at once; null reads public repositories only.
   */
  tokenFile: string | null;
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

/**
 * Reads pull requests from GitHub's REST API: the one address the
 * repository and number name, never one a person gave.
 */
export function githubPullRequests(reader: GitHubReader): ReadPullRequest {
  return async (ref, signal) => {
    const unavailable = (
      reason: Extract<
        PullRequestObservation,
        { kind: 'unavailable' }
      >['reason'],
    ) =>
      PullRequestObservation.parse({
        kind: 'unavailable',
        reason,
        observedAt: new Date().toISOString(),
      });
    let token = '';
    if (reader.tokenFile !== null) {
      try {
        token = readFileSync(reader.tokenFile, 'utf8').trim();
      } catch {
        // Not there: read as an anonymous visitor would.
      }
    }
    const [owner = '', name = ''] = ref.repository.split('/');
    const url = new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${String(ref.number)}`,
      reader.api,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'kinmesh',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
    } catch {
      return unavailable('unreachable');
    }
    if (response.status === 404) return unavailable('not-found');
    if (
      (response.status === 403 || response.status === 429) &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after'))
    )
      return unavailable('rate-limited');
    if (response.status === 401 || response.status === 403)
      return unavailable('forbidden');
    if (!response.ok) return unavailable('unreachable');
    const answer = Answer.safeParse(await response.json().catch(() => null));
    if (!answer.success) return unavailable('unreachable');
    const pull = answer.data;
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
      observedAt: new Date().toISOString(),
    });
    return observed.success ? observed.data : unavailable('unreachable');
  };
}
