import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import * as s from './schema.js';
import { transactional } from './transactional.js';
import { dbNow, type Database } from './database.js';
import { AgentId } from '../domain/contracts.js';

/**
 * `column` is one of `ids`, sent as one array: a worker serves any number of
 * agents, where a parameter each would meet PostgreSQL's limit.
 */
const among = (column: AnyPgColumn, ids: readonly string[]) =>
  sql`${column} = any(${sql.param(ids)}::text[])`;
/** Which agents an Inbox worker serves now: liveness, never authority. */
export function inboxBindingRepository(d: Database) {
  const { q, atomic } = transactional(d);

  return {
    /** Liveness only, never authority: unknown or foreign agent IDs are ignored. */
    async heartbeat(agentIds: string[]) {
      const ids = z.array(AgentId).parse(agentIds);
      if (ids.length === 0) return;
      await atomic(async () => {
        for (const agent of await q()
          .select({ id: s.agents.id, teamId: s.agents.teamId })
          .from(s.agents)
          .where(among(s.agents.id, ids)))
          await q()
            .insert(s.inboxBindings)
            .values({
              agentId: agent.id,
              teamId: agent.teamId,
              lastSeenAt: dbNow,
            })
            .onConflictDoUpdate({
              target: s.inboxBindings.agentId,
              set: { lastSeenAt: dbNow },
            });
      });
    },
    /** A clean stop withdraws liveness at once instead of waiting for it to go stale. */
    async release(agentIds: string[]) {
      const ids = z.array(AgentId).parse(agentIds);
      if (ids.length === 0) return;
      await q()
        .delete(s.inboxBindings)
        .where(among(s.inboxBindings.agentId, ids));
    },
  };
}
