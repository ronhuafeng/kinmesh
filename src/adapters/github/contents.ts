import { z } from 'zod';
import { DomainError } from '../../domain/errors.js';
import {
  PULL_REQUEST_CHANGE_BYTES,
  type GitHubRefusal,
} from '../../domain/pull-requests.js';
import {
  DIRECTORY_ENTRIES_MOST,
  type RepositoryContent,
} from '../../domain/repository.js';
import { GitHubRefused, githubRequest } from './installations.js';

const refused = (
  reason: GitHubRefusal,
  kind: 'forbidden' | 'not-found' | 'too-large' | 'invalid',
) => new DomainError(kind, { reason });
const Repo = z.object({ full_name: z.string(), default_branch: z.string() });
const Commit = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
const File = z.object({
  type: z.literal('file'),
  size: z.number().int().nonnegative(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});
const Entries = z.array(
  z.object({ name: z.string(), type: z.string() }).loose(),
);

/**
 * Reads a file's text, or a directory's entries, of a repository with the
 * installation's token, at a branch or commit (the default branch when
 * null). Reading never writes; every refusal says why in the agent's words.
 */
export async function readRepository(
  api: string,
  token: string,
  read: { repository: string; ref: string | null; path: string },
): Promise<RepositoryContent> {
  const get = (path: string) =>
    githubRequest(api, path, {
      authorization: `Bearer ${token}`,
      timeoutMs: 20_000,
    });
  const repo = `/repos/${read.repository}`;
  const found = await get(repo);
  // Without the app's access GitHub says 403, or 404 to hide it.
  if (found.status === 403 || found.status === 404)
    throw refused('repository-not-connected', 'forbidden');
  const where = Repo.safeParse(found.json);
  if (found.status >= 300 || !where.success)
    throw new GitHubRefused(found.status);
  const ref = read.ref ?? where.data.default_branch;
  const at = await get(`${repo}/commits/${encodeURIComponent(ref)}`);
  if (at.status === 404 || at.status === 422)
    throw refused('ref-missing', 'not-found');
  const commit = Commit.safeParse(at.json);
  if (at.status >= 300 || !commit.success) throw new GitHubRefused(at.status);
  const sha = commit.data.sha;
  const asked = read.path.split('/').map(encodeURIComponent).join('/');
  const content = await get(
    `${repo}/contents${asked === '' ? '' : '/' + asked}?ref=${sha}`,
  );
  if (content.status === 404) throw refused('path-missing', 'not-found');
  if (content.status >= 300) throw new GitHubRefused(content.status);
  const base = {
    repository: where.data.full_name,
    commit: sha,
    path: read.path,
  };
  const listed = Entries.safeParse(content.json);
  if (listed.success)
    return {
      kind: 'directory',
      ...base,
      entries: listed.data.slice(0, DIRECTORY_ENTRIES_MOST).map((e) => ({
        name: e.name,
        kind:
          e.type === 'file' ? 'file' : e.type === 'dir' ? 'directory' : 'other',
      })),
    };
  const file = File.safeParse(content.json);
  // A link or a submodule has no text of its own.
  if (!file.success) throw refused('not-text', 'invalid');
  if (file.data.size > PULL_REQUEST_CHANGE_BYTES)
    throw refused('too-large', 'too-large');
  // GitHub leaves out what it would not encode, past a megabyte.
  if (file.data.encoding !== 'base64' || file.data.content === undefined)
    throw refused('too-large', 'too-large');
  const bytes = Buffer.from(file.data.content, 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw refused('not-text', 'invalid');
  }
  if (text.includes('\0')) throw refused('not-text', 'invalid');
  return { kind: 'file', ...base, text };
}
