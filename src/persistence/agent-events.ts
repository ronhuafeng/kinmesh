import type { Database } from './database.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import * as s from './schema.js';
import { transactional } from './transactional.js';
import type { AgentId, TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import {
  RuntimeEvent,
  RuntimeEventInput,
  type RuntimeState,
} from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { principalAuthor as author } from '../domain/tasks.js';
import type { agentRepository } from './agents.js';

function parseJson(value: string): unknown {
  return JSON.parse(value);
}
const now = () => new Date().toISOString();
/**
 * What an agent's runs report as they go, against a correlation it made:
 * written by the agent, read by whoever may see the agent's executions.
 */
export function agentEventRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
) {
  const { q, atomic } = transactional(d);
  return {
    runtimeEvent(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      id: string,
      state: z.infer<typeof RuntimeState>,
    ) {
      return atomic(async () => {
        const agent = await agents.authorize(
          p,
          teamId,
          agentId,
          'executions:write',
        );
        if (agent.lifecycle !== 'active') throw new DomainError('conflict');
        await agents.correlation(teamId, agentId, id);
        RuntimeEventInput.parse({ state });
        const event = {
          id: randomUUID(),
          correlationId: id,
          state,
          author: author(p),
          createdAt: now(),
        };
        await q()
          .insert(s.agentRuntimeEvents)
          .values({ ...event, author: JSON.stringify(event.author) });
        return RuntimeEvent.parse(event);
      });
    },
    async runtimeEvents(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      id: string,
    ) {
      await agents.authorize(p, teamId, agentId, 'executions:read');
      await agents.correlation(teamId, agentId, id);
      return (
        await q()
          .select(s.runtimeEventFields)
          .from(s.agentRuntimeEvents)
          .where(eq(s.agentRuntimeEvents.correlationId, id))
      ).map((r) => RuntimeEvent.parse({ ...r, author: parseJson(r.author) }));
    },
  };
}
