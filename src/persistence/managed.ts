import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { Database } from './database.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import type { GrantInput } from '../domain/agents.js';
import { AgentId, TeamId } from '../domain/contracts.js';
import { Endpoint } from '../adapters/t3/oauth.js';

/** A presence write per agent at most this often; Team MCP calls are frequent. */
const PRESENCE_MS = 30_000;
const Provider = z.string().trim().min(1).max(256);

/**
 * What the hub manages for its own worker: the team's T3 connection and the
 * agents it serves. Rows hold no secrets; tokens live in files.
 */
export function managedRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
) {
  const { q, atomic } = d;
  /** A person of the team: T3 and the hub-held secrets are everyone's. */
  async function person(p: Principal, teamId: TeamId) {
    // Agents are refused before their grant is looked at.
    if (p.kind !== 'human') throw new IdentityError(403);
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
  async function binding(teamId: TeamId, agentId: AgentId) {
    const [row] = await q()
      .select()
      .from(s.managedBindings)
      .where(
        and(
          eq(s.managedBindings.agentId, AgentId.parse(agentId)),
          eq(s.managedBindings.teamId, teamId),
        ),
      )
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
    async binding(p: Principal, teamId: TeamId, agentId: AgentId) {
      await person(p, teamId);
      return binding(teamId, agentId);
    },
    /** Agents of one team the hub's worker serves, for a person of it. */
    teamBindings(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await person(p, teamId);
        return await q()
          .select({
            agentId: s.managedBindings.agentId,
            providerId: s.managedBindings.providerId,
            grantId: s.managedBindings.grantId,
          })
          .from(s.managedBindings)
          .where(eq(s.managedBindings.teamId, teamId));
      });
    },
    /** Every agent the hub's worker serves, with its team's T3 endpoint. */
    workerBindings() {
      return q()
        .select({
          agentId: s.managedBindings.agentId,
          providerId: s.managedBindings.providerId,
          endpoint: s.t3Connections.endpoint,
        })
        .from(s.managedBindings)
        .innerJoin(
          s.t3Connections,
          eq(s.t3Connections.teamId, s.managedBindings.teamId),
        );
    },
    /**
     * Point the agent at the connected T3 environment and the chosen provider
     * and model. An agent the worker already serves keeps its credential, so
     * a run under way can still post its answer; otherwise the worker gets a
     * new one, whose token the caller writes to its private file.
     */
    connect(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      choice: { providerId: string; modelId: string },
      input: GrantInput,
    ) {
      return atomic(async () => {
        await person(p, teamId);
        const t3 = await connection(teamId);
        if (t3 === null) throw new IdentityError(409);
        const providerId = Provider.parse(choice.providerId);
        const profile = await agents.get(p, teamId, agentId);
        await agents.update(p, teamId, agentId, {
          name: profile.name,
          role: profile.role,
          capabilities: profile.capabilities,
          memoryLocation: profile.memoryLocation,
          preferences: {
            environmentId: t3.environmentId,
            providerId,
            modelId: Provider.parse(choice.modelId),
          },
        });
        const old = await binding(teamId, agentId);
        const live =
          old !== null &&
          (await agents.grants(p, teamId, agentId)).some(
            (g) => g.id === old.grantId && g.revokedAt === null,
          );
        if (old !== null && live) {
          await q()
            .update(s.managedBindings)
            .set({ providerId })
            .where(eq(s.managedBindings.agentId, agentId));
          return null;
        }
        const issued = await agents.issue(p, teamId, agentId, input);
        const row = { grantId: issued.grant.id, providerId };
        await q()
          .insert(s.managedBindings)
          .values({ agentId, teamId, ...row, createdAt: Date.now() })
          .onConflictDoUpdate({ target: s.managedBindings.agentId, set: row });
        return issued;
      });
    },
    /** Stop serving the agent and revoke its worker credential. */
    disconnect(p: Principal, teamId: TeamId, agentId: AgentId) {
      return atomic(async () => {
        await person(p, teamId);
        const old = await binding(teamId, agentId);
        if (old === null) return false;
        await agents.revoke(p, teamId, agentId, old.grantId);
        await q()
          .delete(s.managedBindings)
          .where(eq(s.managedBindings.agentId, agentId));
        return true;
      });
    },
    /** A revoked worker credential ends the binding it served. */
    async forgetGrant(teamId: TeamId, agentId: AgentId, grantId: string) {
      const done = await q()
        .delete(s.managedBindings)
        .where(
          and(
            eq(s.managedBindings.agentId, agentId),
            eq(s.managedBindings.teamId, teamId),
            eq(s.managedBindings.grantId, grantId),
          ),
        );
      return done.count === 1;
    },
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
