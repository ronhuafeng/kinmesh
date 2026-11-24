import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import * as s from './schema.js';
import type { Database } from './database.js';
import { DomainError } from '../domain/errors.js';
import type { Principal } from '../domain/agents.js';
import type { TaskId } from '../domain/contracts.js';
import { principalAuthor } from '../domain/tasks.js';
import {
  TaskPullRequest,
  TaskPullRequestView,
  pullRequestKey,
  TASK_PULL_REQUESTS_MOST,
  type PullRequestRef,
} from '../domain/pull-requests.js';

const decode = (value: string): unknown => JSON.parse(value);

/**
 * Pull requests linked to tasks, read with what GitHub last said about
 * them. Authorization is the caller's: the task repository checks access
 * before it links or lists.
 */
export function pullRequestRepository(d: Database) {
  const { q } = d;
  function view(
    row: typeof s.taskPullRequests.$inferSelect,
    observation: string | null,
  ) {
    return TaskPullRequestView.parse({
      id: row.id,
      position: row.position,
      taskId: row.taskId,
      pullRequest: { repository: row.repository, number: row.number },
      author: decode(row.author),
      createdAt: row.createdAt,
      observation: observation === null ? null : decode(observation),
    });
  }
  return {
    /** Links a pull request to a task, once. Run inside the task's command. */
    async link(
      p: Principal,
      taskId: TaskId,
      ref: PullRequestRef,
      time: string,
    ): Promise<TaskPullRequest> {
      const pullKey = pullRequestKey(ref);
      const linked = await q()
        .select({ pullKey: s.taskPullRequests.pullKey })
        .from(s.taskPullRequests)
        .where(eq(s.taskPullRequests.taskId, taskId));
      if (linked.some((r) => r.pullKey === pullKey))
        throw new DomainError('conflict');
      if (linked.length >= TASK_PULL_REQUESTS_MOST)
        throw new DomainError('too-large');
      const row = (
        await q()
          .insert(s.taskPullRequests)
          .values({
            id: randomUUID(),
            taskId,
            pullKey,
            repository: ref.repository,
            number: ref.number,
            author: JSON.stringify(principalAuthor(p)),
            createdAt: time,
          })
          .returning()
      )[0];
      if (row === undefined) throw new Error('Pull request link not recorded');
      return TaskPullRequest.parse({
        id: row.id,
        position: row.position,
        taskId: row.taskId,
        pullRequest: { repository: row.repository, number: row.number },
        author: decode(row.author),
        createdAt: row.createdAt,
      });
    },
    /** A task's linked pull requests, oldest first, with what GitHub said. */
    async forTask(taskId: TaskId) {
      const rows = await q()
        .select({
          link: s.taskPullRequests,
          observation: s.githubPullRequests.observation,
        })
        .from(s.taskPullRequests)
        .leftJoin(
          s.githubPullRequests,
          eq(s.githubPullRequests.pullKey, s.taskPullRequests.pullKey),
        )
        .where(eq(s.taskPullRequests.taskId, taskId))
        .orderBy(asc(s.taskPullRequests.position))
        .limit(TASK_PULL_REQUESTS_MOST);
      return rows.map((r) => view(r.link, r.observation));
    },
  };
}
