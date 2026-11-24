import { z } from 'zod';
import {
  BranchName,
  FilePath,
  PULL_REQUEST_CHANGE_BYTES,
  Repository,
} from './pull-requests.js';

/** A commit, as GitHub names one. */
const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);
/** Most entries one directory read lists, as GitHub lists them. */
export const DIRECTORY_ENTRIES_MOST = 1000;
/**
 * What an agent working on a task reads of a connected repository: a file's
 * text or a directory's entries (`path` empty for the top), at a branch or a
 * commit (`ref`; the repository's default branch when null).
 */
export const RepositoryRead = {
  repository: Repository,
  ref: z.union([BranchName, CommitSha]).nullable().default(null),
  path: z.union([z.literal(''), FilePath]).default(''),
};
/**
 * What was read, at the commit `ref` named then: a file's whole text, at
 * most as much as a pull request may carry, or a directory's entries.
 */
export const RepositoryContent = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    repository: Repository,
    commit: CommitSha,
    path: FilePath,
    text: z.string().max(PULL_REQUEST_CHANGE_BYTES),
  }),
  z.strictObject({
    kind: z.literal('directory'),
    repository: Repository,
    commit: CommitSha,
    path: z.union([z.literal(''), FilePath]),
    entries: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(255),
          kind: z.enum(['file', 'directory', 'other']),
        }),
      )
      .max(DIRECTORY_ENTRIES_MOST),
  }),
]);
export type RepositoryContent = z.infer<typeof RepositoryContent>;
