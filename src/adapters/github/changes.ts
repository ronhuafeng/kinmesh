import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import type {
  OpeningRefusal,
  PullRequestRef,
} from '../../domain/pull-requests.js';
import { GitHubRefused } from './installations.js';

/** A change to open as a pull request, as Kinmesh words it on GitHub. */
export interface Opening {
  repository: string;
  /** The branch it starts from; null for the repository's default. */
  base: string | null;
  branch: string;
  title: string;
  body: string;
  files: { path: string; content: string | null }[];
  /** The commit's message. */
  message: string;
  /**
   * A line only this change's commit carries: a branch whose head has it
   * is this change's own, made by an earlier attempt.
   */
  marker: string;
}

const refused = (reason: OpeningRefusal, kind: 'forbidden' | 'conflict') =>
  new DomainError(kind, { reason });
const Ref = z.object({ object: z.object({ sha: z.string() }) });
const Commit = z.object({
  sha: z.string(),
  message: z.string(),
  tree: z.object({ sha: z.string() }),
});
const Pulls = z.array(z.object({ number: z.number().int().positive() }));

/**
 * Opens a change as a pull request with the installation's token: one
 * commit on a new branch from the base, then the pull request. It is safe
 * to repeat: a branch this change already made, and its pull request, are
 * found and used again, so one change never opens two. A branch that is
 * anyone else's is never written to.
 */
export async function openPullRequest(
  api: string,
  token: string,
  opening: Opening,
): Promise<PullRequestRef> {
  /** One request: its status and JSON, for the steps that read either. */
  async function send(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await fetch(new URL(path, api), {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'kinmesh',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GitHubRefused(0);
    }
    // Without the app's access GitHub says 403, or 404 to hide the
    // repository: either way it is not one the team connected.
    if (response.status === 403)
      throw refused('repository-not-connected', 'forbidden');
    return {
      status: response.status,
      json: await response.json().catch(() => null),
    };
  }
  /** A step that must succeed, its answer parsed by `schema`. */
  async function must<T>(
    schema: z.ZodType<T>,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ) {
    const { status, json } = await send(method, path, body);
    const parsed = schema.safeParse(json);
    if (status >= 300 || !parsed.success) throw new GitHubRefused(status);
    return parsed.data;
  }
  const repo = `/repos/${opening.repository}`;
  const ref = (branch: string) =>
    `${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;

  const found = await send('GET', repo);
  const where = z
    .object({
      full_name: z.string(),
      default_branch: z.string(),
      owner: z.object({ login: z.string() }),
    })
    .safeParse(found.json);
  if (found.status === 404)
    throw refused('repository-not-connected', 'forbidden');
  if (found.status >= 300 || !where.success)
    throw new GitHubRefused(found.status);
  const base = opening.base ?? where.data.default_branch;
  const baseRef = await send('GET', ref(base));
  if (baseRef.status === 404) throw refused('base-missing', 'conflict');
  const baseSha = Ref.safeParse(baseRef.json);
  if (baseRef.status >= 300 || !baseSha.success)
    throw new GitHubRefused(baseRef.status);

  /** The branch's head, if this change made it; refused if it is another's. */
  const ours = async () => {
    const head = await send('GET', ref(opening.branch));
    if (head.status === 404) return false;
    const sha = Ref.safeParse(head.json);
    if (head.status >= 300 || !sha.success)
      throw new GitHubRefused(head.status);
    const commit = await must(
      Commit,
      'GET',
      `${repo}/git/commits/${sha.data.object.sha}`,
    );
    if (!commit.message.split('\n').includes(opening.marker))
      throw refused('branch-taken', 'conflict');
    return true;
  };
  if (!(await ours())) {
    const parent = baseSha.data.object.sha;
    const { tree } = await must(Commit, 'GET', `${repo}/git/commits/${parent}`);
    const made = await send('POST', `${repo}/git/trees`, {
      base_tree: tree.sha,
      tree: opening.files.map((f) => ({
        path: f.path,
        mode: '100644',
        type: 'blob',
        ...(f.content === null ? { sha: null } : { content: f.content }),
      })),
    });
    // Removing a file that is not there, say.
    if (made.status === 422) throw new DomainError('invalid');
    const newTree = z.object({ sha: z.string() }).safeParse(made.json);
    if (made.status >= 300 || !newTree.success)
      throw new GitHubRefused(made.status);
    const commit = await must(Commit, 'POST', `${repo}/git/commits`, {
      message: opening.message,
      tree: newTree.data.sha,
      parents: [parent],
    });
    const branch = await send('POST', `${repo}/git/refs`, {
      ref: `refs/heads/${opening.branch}`,
      sha: commit.sha,
    });
    // Another attempt at the same change made it first: it must be ours.
    if (branch.status === 422) await ours();
    else if (branch.status >= 300) throw new GitHubRefused(branch.status);
  }

  const owner = where.data.owner.login;
  const listed = async () =>
    (
      await must(
        Pulls,
        'GET',
        `${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${opening.branch}`)}`,
      )
    )[0]?.number;
  let number = await listed();
  if (number === undefined) {
    const opened = await send('POST', `${repo}/pulls`, {
      title: opening.title,
      head: opening.branch,
      base,
      body: opening.body,
    });
    const pull = z
      .object({ number: z.number().int().positive() })
      .safeParse(opened.json);
    // 422: one was opened for the branch meanwhile.
    number = pull.success ? pull.data.number : await listed();
    if (number === undefined) throw new GitHubRefused(opened.status);
  }
  return { repository: where.data.full_name, number };
}
