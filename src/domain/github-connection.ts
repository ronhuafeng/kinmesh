import { z } from 'zod';
import { Repository } from './pull-requests.js';

/**
 * Where the team's GitHub connection stands, as the connections page shows
 * it: nothing yet; created on GitHub, with where to choose its
 * repositories; installed, with its account and the repositories agents
 * may work in (null: all of the account's); or installed but GitHub can't
 * be read now.
 */
export const GitHubStatus = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('none') }),
  z.strictObject({ state: z.literal('created'), installUrl: z.url() }),
  z.strictObject({
    state: z.literal('installed'),
    account: z.string().min(1).max(100),
    repositories: z.array(Repository).max(100).nullable(),
    more: z.boolean(),
    manageUrl: z.url(),
  }),
  z.strictObject({
    state: z.literal('unreachable'),
    account: z.string().min(1).max(100).nullable(),
  }),
]);
export type GitHubStatus = z.infer<typeof GitHubStatus>;
/** What the page posts to GitHub to create the team's app. */
export const GitHubManifest = z.strictObject({
  action: z.url(),
  manifest: z.string().max(4000),
});
