import { transactional } from './transactional.js';
import { eq, sql } from 'drizzle-orm';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { Database } from './database.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import type { TeamId } from '../domain/contracts.js';

/** A presence write per agent at most this often; Team MCP calls are frequent. */
const PRESENCE_MS = 30_000;
/** When each agent's credential last reached Team MCP: evidence, never authority. */
export function teamMcpPresenceRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
) {
  const { q, atomic } = transactional(d);

  /** A person of the team: T3 and the hub-held secrets are everyone's. */
  async function person(p: Principal, teamId: TeamId) {
    // Agents are refused before their grant is looked at.
    if (p.kind !== 'human') throw new DomainError('forbidden');
    await agents.person(p, teamId);
  }
  return {
    /** Record that an agent's credential reached Team MCP. Evidence only. */
    async seenByTeamMcp(p: Principal) {
      if (p.kind !== 'agent') return;
      const now = Date.now();
      await q()
        .insert(s.teamMcpPresence)
        .values({ agentId: p.agentId, teamId: p.teamId, lastSeenAt: now })
        .onConflictDoUpdate({
          target: s.teamMcpPresence.agentId,
          set: { lastSeenAt: now },
          setWhere: sql`${s.teamMcpPresence.lastSeenAt} < ${now - PRESENCE_MS}`,
        });
    },
    /** When each of the team's agents last reached Team MCP, for a person of it. */
    teamMcpPresence(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await person(p, teamId);
        return await q()
          .select({
            agentId: s.teamMcpPresence.agentId,
            lastSeenAt: s.teamMcpPresence.lastSeenAt,
          })
          .from(s.teamMcpPresence)
          .where(eq(s.teamMcpPresence.teamId, teamId));
      });
    },
  };
}
