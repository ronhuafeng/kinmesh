import { transactional } from './transactional.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { Database } from './database.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { TeamId } from '../domain/contracts.js';
import { Endpoint } from '../adapters/t3/oauth.js';

/** The one T3 each team uses: connected by a person, or set for the deployment. */
export function t3ConnectionRepository(
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
  async function connection(teamId: TeamId) {
    const [row] = await q()
      .select()
      .from(s.t3Connections)
      .where(eq(s.t3Connections.teamId, TeamId.parse(teamId)))
      .limit(1);
    return row ?? null;
  }
  return {
    async connection(p: Principal, teamId: TeamId) {
      await person(p, teamId);
      return connection(teamId);
    },
    /**
     * The one T3 a team uses, for anyone of the team, a person or one of its
     * agents (checking a run): no secrets in the row.
     */
    teamConnection(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await agents.teamAccess(p, teamId);
        return connection(teamId);
      });
    },
    async saveConnection(
      p: Principal,
      teamId: TeamId,
      endpoint: string,
      environmentId: string,
    ) {
      await atomic(async () => {
        await person(p, teamId);
        const row = {
          endpoint: Endpoint.parse(endpoint),
          environmentId: z.string().min(1).max(256).parse(environmentId),
          connectedAt: Date.now(),
        };
        await q()
          .insert(s.t3Connections)
          .values({ teamId, ...row })
          .onConflictDoUpdate({ target: s.t3Connections.teamId, set: row });
      });
    },
    /**
     * The T3 the deployment connects, for the instance's team: no person
     * signs it in. Returns how many teams it was set for (none before the
     * first person has signed in and so made the team).
     */
    async provision(endpoint: string, environmentId: string) {
      return atomic(async () => {
        const row = {
          endpoint: Endpoint.parse(endpoint),
          environmentId: z.string().min(1).max(256).parse(environmentId),
        };
        const teams = await q().select({ id: s.teams.id }).from(s.teams);
        for (const team of teams) {
          const [current] = await q()
            .select()
            .from(s.t3Connections)
            .where(eq(s.t3Connections.teamId, team.id))
            .limit(1);
          // Unchanged: keep when it was connected.
          if (
            current?.endpoint === row.endpoint &&
            current.environmentId === row.environmentId
          )
            continue;
          await q()
            .insert(s.t3Connections)
            .values({ teamId: team.id, ...row, connectedAt: Date.now() })
            .onConflictDoUpdate({
              target: s.t3Connections.teamId,
              set: { ...row, connectedAt: Date.now() },
            });
        }
        return teams.length;
      });
    },
  };
}
