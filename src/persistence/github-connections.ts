import { eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import type { Database } from './database.js';
import { transactional } from './transactional.js';
import type { agentRepository } from './agents.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { TeamId } from '../domain/contracts.js';

const Slug = z.string().regex(/^[a-z0-9-]{1,100}$/);
/**
 * The GitHub App each team connected, and where it is installed. People of
 * the team connect it; agents never see it.
 */
export function githubConnectionRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
) {
  const { q, atomic } = transactional(d);
  async function person(p: Principal, teamId: TeamId) {
    // Agents are refused before their grant is looked at.
    if (p.kind !== 'human') throw new DomainError('forbidden');
    await agents.person(p, teamId);
    return p;
  }
  async function row(teamId: TeamId) {
    const [found] = await q()
      .select()
      .from(s.githubConnections)
      .where(eq(s.githubConnections.teamId, TeamId.parse(teamId)))
      .limit(1);
    return found ?? null;
  }
  return {
    /** The team's connection, for a person of it; null before one. */
    connection(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await person(p, teamId);
        return row(teamId);
      });
    },
    /** A person created the team's app on GitHub; it is not installed yet. */
    created(p: Principal, teamId: TeamId, slug: string) {
      return atomic(async () => {
        const { humanId } = await person(p, teamId);
        const value = {
          slug: Slug.parse(slug),
          installationId: null,
          account: null,
          createdBy: humanId,
          createdAt: Date.now(),
        };
        await q()
          .insert(s.githubConnections)
          .values({ teamId, ...value })
          .onConflictDoUpdate({
            target: s.githubConnections.teamId,
            set: value,
          });
      });
    },
    /** A person installed the team's app on an account's repositories. */
    installed(
      p: Principal,
      teamId: TeamId,
      installationId: number,
      account: string,
    ) {
      return atomic(async () => {
        await person(p, teamId);
        const changed = await q()
          .update(s.githubConnections)
          .set({
            installationId: z.number().int().positive().parse(installationId),
            account: z.string().min(1).max(100).parse(account),
          })
          .where(eq(s.githubConnections.teamId, teamId));
        if (changed.count !== 1) throw new DomainError('conflict');
      });
    },
    /**
     * Where the deployment's app is installed, for the hub's own reads: one
     * team per deployment. Null before anyone installed it.
     */
    async installation() {
      const [found] = await q()
        .select({
          installationId: s.githubConnections.installationId,
        })
        .from(s.githubConnections)
        .where(isNotNull(s.githubConnections.installationId))
        .limit(1);
      return found?.installationId ?? null;
    },
  };
}
