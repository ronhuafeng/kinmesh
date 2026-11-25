import { and, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { Database } from './database.js';
import * as s from './schema.js';
import { Author, CorrelationInput } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { pullRequestKey } from '../domain/pull-requests.js';
import type { Task } from '../domain/tasks.js';
import {
  ProofInput,
  TaskProof,
  type ProofCite,
  type ProofPiece,
} from '../domain/task-proof.js';

/**
 * The proof an owner cites when it asks for review, as it is kept: each
 * criterion by its text, each piece checked to be the task's own (a pull
 * request or run linked to it) or its channel's (a message), and kept as it
 * was then. Anything else refuses the whole request alike, saying nothing of
 * what it named. Run inside the request's transaction.
 */
export async function proofOf(
  q: Database['q'],
  task: Task,
  input: ProofInput,
  author: z.infer<typeof Author>,
  time: string,
): Promise<TaskProof> {
  const given = ProofInput.parse(input);
  const piece = async (cite: ProofCite): Promise<ProofPiece> => {
    switch (cite.kind) {
      case 'pull-request': {
        const [linked] = await q()
          .select({ id: s.taskPullRequests.id })
          .from(s.taskPullRequests)
          .where(
            and(
              eq(s.taskPullRequests.taskId, task.id),
              eq(s.taskPullRequests.pullKey, pullRequestKey(cite.pullRequest)),
            ),
          )
          .limit(1);
        if (linked === undefined) throw new DomainError('invalid');
        return cite;
      }
      case 'run': {
        const [run] = await q()
          .select()
          .from(s.taskExecutions)
          .where(
            and(
              eq(s.taskExecutions.id, cite.executionId),
              eq(s.taskExecutions.taskId, task.id),
            ),
          )
          .limit(1);
        if (run === undefined) throw new DomainError('invalid');
        return {
          kind: 'run',
          executionId: run.id,
          reference: CorrelationInput.shape.reference.parse(
            JSON.parse(run.reference),
          ),
          linkedAt: run.createdAt,
        };
      }
      case 'message': {
        const [message] = await q()
          .select()
          .from(s.messages)
          .where(
            and(
              eq(s.messages.id, cite.messageId),
              eq(s.messages.channelId, task.channelId),
              isNull(s.messages.withdrawnAt),
            ),
          )
          .limit(1);
        if (message === undefined) throw new DomainError('invalid');
        return {
          kind: 'message',
          messageId: cite.messageId,
          author: Author.parse(JSON.parse(message.author)),
          sentAt: message.createdAt,
        };
      }
      case 'link':
        return cite;
    }
  };
  const criteria = [];
  for (const c of given) {
    const criterion = task.criteria[c.criterion];
    if (criterion === undefined) throw new DomainError('invalid');
    const pieces = [];
    for (const cite of c.pieces ?? []) pieces.push(await piece(cite));
    criteria.push({ criterion, words: c.words ?? null, pieces });
  }
  return TaskProof.parse({ author, givenAt: time, criteria });
}
