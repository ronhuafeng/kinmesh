import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import type { ReadPullRequest } from '../adapters/github/pull-requests.js';
import { describeFailure } from '../diagnostics.js';

/** How often the hub looks for pull requests to ask GitHub about. */
const LOOK_MS = 30_000;
/** The most it asks about in one look, so a long list waits its turn. */
const MOST = 20;

/**
 * Keeps what GitHub says about linked pull requests current while the hub
 * runs: a new link within a look, open ones every few minutes, merged or
 * closed ones a few times a day. GitHub limiting how often Kinmesh may ask
 * ends a look early.
 */
export function startPullRequestUpkeep(
  app: FastifyInstance,
  store: Store,
  read: ReadPullRequest,
) {
  const stop = new AbortController();
  const stopped = () => stop.signal.aborted;
  let looking = false;
  const look = async () => {
    if (looking || stopped()) return;
    looking = true;
    try {
      for (const { pullKey, ref } of await store.githubObservations.due(
        Date.now(),
        MOST,
      )) {
        const observation = await read(ref, stop.signal);
        if (stopped()) return;
        await store.githubObservations.observe(
          pullKey,
          observation,
          Date.now(),
        );
        if (
          observation.kind === 'unavailable' &&
          observation.reason === 'rate-limited'
        )
          return;
      }
    } catch (error) {
      app.log.error(describeFailure(error), 'pull_request_upkeep_failed');
    } finally {
      looking = false;
    }
  };
  void look();
  const timer = setInterval(() => void look(), LOOK_MS);
  timer.unref();
  app.addHook('onClose', () => {
    stop.abort();
    clearInterval(timer);
    return Promise.resolve();
  });
}
