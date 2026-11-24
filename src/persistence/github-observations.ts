import { eq, sql } from 'drizzle-orm';
import * as s from './schema.js';
import type { Database } from './database.js';
import {
  PullRequestObservation,
  askAgainAfter,
} from '../domain/pull-requests.js';

const decode = (value: string): unknown => JSON.parse(value);

/**
 * What GitHub said about each linked pull request, kept current by the
 * hub. It reads only links, and writes only what GitHub answered.
 */
export function githubObservationRepository(d: Database) {
  const { q, atomic } = d;
  return {
    /**
     * Linked pull requests GitHub should be asked about now: never asked,
     * or asked longer ago than their state allows. Oldest question first.
     */
    async due(now: number, most: number) {
      const rows = await q()
        .select({
          pullKey: s.taskPullRequests.pullKey,
          repository: sql<string>`min(${s.taskPullRequests.repository})`,
          number: sql<number>`min(${s.taskPullRequests.number})`,
          checkedAt: s.githubPullRequests.checkedAt,
          observation: s.githubPullRequests.observation,
        })
        .from(s.taskPullRequests)
        .leftJoin(
          s.githubPullRequests,
          eq(s.githubPullRequests.pullKey, s.taskPullRequests.pullKey),
        )
        .groupBy(
          s.taskPullRequests.pullKey,
          s.githubPullRequests.checkedAt,
          s.githubPullRequests.observation,
        )
        .orderBy(sql`${s.githubPullRequests.checkedAt} ASC NULLS FIRST`);
      return rows
        .filter((r) => {
          if (r.checkedAt === null || r.observation === null) return true;
          const seen = PullRequestObservation.parse(decode(r.observation));
          return now - r.checkedAt >= askAgainAfter(seen);
        })
        .slice(0, most)
        .map((r) => ({
          pullKey: r.pullKey,
          ref: { repository: r.repository, number: r.number },
        }));
    },
    /**
     * Keeps what GitHub said about a pull request. A passing failure (a
     * limit, an outage) keeps the last answer, which then shows its age;
     * a definite one (no such pull request, a refused credential) replaces it.
     */
    observe(pullKey: string, observation: PullRequestObservation, now: number) {
      const next = PullRequestObservation.parse(observation);
      const passing =
        next.kind === 'unavailable' &&
        (next.reason === 'rate-limited' || next.reason === 'unreachable');
      const value = JSON.stringify(next);
      return atomic(async () => {
        await q()
          .insert(s.githubPullRequests)
          .values({ pullKey, observation: value, checkedAt: now })
          .onConflictDoUpdate({
            target: s.githubPullRequests.pullKey,
            set: passing
              ? {
                  checkedAt: now,
                  observation: sql`CASE WHEN ${s.githubPullRequests.observation}::jsonb ->> 'kind' = 'observed' THEN ${s.githubPullRequests.observation} ELSE ${value} END`,
                }
              : { observation: value, checkedAt: now },
          });
      });
    },
  };
}
