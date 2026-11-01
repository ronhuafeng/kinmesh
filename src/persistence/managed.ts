import { and, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import { transactional } from './transactional.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import type { GrantInput } from '../domain/agents.js';
import { AgentId, TeamId } from '../domain/contracts.js';
import { Endpoint } from '../adapters/t3/oauth.js';

/** A presence write per agent at most this often; Team MCP calls are frequent. */
const PRESENCE_MS = 30_000;
const Provider = z.string().trim().min(1).max(256);

/**
 * What the hub manages for its own worker: the team's T3 connection and the
 * agents it serves (ADR 0007). Rows hold no secrets; tokens live in files.
 */
export function managedRepository(
  db: BetterSQLite3Database<typeof s>,
  agents: ReturnType<typeof agentRepository>,
) {
  const { atomic } = transactional(db);
  function owner(p: Principal, teamId: TeamId) {
    if (
      p.kind !== 'human' ||
      agents.teamAccess(p, teamId, 'agents:read').role !== 'owner'
    )
      throw new IdentityError(403);
  }
  function connection(teamId: TeamId) {
    return (
      db
        .select()
        .from(s.t3Connections)
        .where(eq(s.t3Connections.teamId, TeamId.parse(teamId)))
        .get() ?? null
    );
  }
  function binding(teamId: TeamId, agentId: AgentId) {
    return (
      db
        .select()
        .from(s.managedBindings)
        .where(
          and(
            eq(s.managedBindings.agentId, AgentId.parse(agentId)),
            eq(s.managedBindings.teamId, teamId),
          ),
        )
        .get() ?? null
    );
  }
  return {
    connection(p: Principal, teamId: TeamId) {
      owner(p, teamId);
      return connection(teamId);
    },
    saveConnection(
      p: Principal,
      teamId: TeamId,
      endpoint: string,
      environmentId: string,
    ) {
      atomic(() => {
        owner(p, teamId);
        const row = {
          endpoint: Endpoint.parse(endpoint),
          environmentId: z.string().min(1).max(256).parse(environmentId),
          connectedAt: Date.now(),
        };
        db.insert(s.t3Connections)
          .values({ teamId, ...row })
          .onConflictDoUpdate({ target: s.t3Connections.teamId, set: row })
          .run();
      });
    },
    binding(p: Principal, teamId: TeamId, agentId: AgentId) {
      owner(p, teamId);
      return binding(teamId, agentId);
    },
    /** Agents of one team the hub's worker serves. */
    teamBindings(teamId: TeamId) {
      return db
        .select({
          agentId: s.managedBindings.agentId,
          providerId: s.managedBindings.providerId,
          grantId: s.managedBindings.grantId,
        })
        .from(s.managedBindings)
        .where(eq(s.managedBindings.teamId, teamId))
        .all();
    },
    /** Every agent the hub's worker serves, with its team's T3 endpoint. */
    workerBindings() {
      return db
        .select({
          agentId: s.managedBindings.agentId,
          providerId: s.managedBindings.providerId,
          endpoint: s.t3Connections.endpoint,
        })
        .from(s.managedBindings)
        .innerJoin(
          s.t3Connections,
          eq(s.t3Connections.teamId, s.managedBindings.teamId),
        )
        .all();
    },
    /**
     * Point the agent at the connected T3 environment and the chosen provider
     * and model, and give the worker a fresh credential. Reconnecting rotates
     * the old one. The caller writes the returned token to its private file.
     */
    connect(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      choice: { providerId: string; modelId: string },
      input: GrantInput,
    ) {
      return atomic(() => {
        owner(p, teamId);
        const t3 = connection(teamId);
        if (t3 === null) throw new IdentityError(409);
        const providerId = Provider.parse(choice.providerId);
        const profile = agents.get(p, teamId, agentId);
        agents.update(p, teamId, agentId, {
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
        const old = binding(teamId, agentId);
        const live =
          old !== null &&
          agents
            .grants(p, teamId, agentId)
            .some((g) => g.id === old.grantId && g.revokedAt === null);
        const issued =
          old !== null && live
            ? agents.rotate(p, teamId, agentId, old.grantId, input)
            : agents.issue(p, teamId, agentId, input);
        const row = { grantId: issued.grant.id, providerId };
        db.insert(s.managedBindings)
          .values({ agentId, teamId, ...row, createdAt: Date.now() })
          .onConflictDoUpdate({ target: s.managedBindings.agentId, set: row })
          .run();
        return issued;
      });
    },
    /** Stop serving the agent and revoke its worker credential. */
    disconnect(p: Principal, teamId: TeamId, agentId: AgentId) {
      return atomic(() => {
        owner(p, teamId);
        const old = binding(teamId, agentId);
        if (old === null) return false;
        agents.revoke(p, teamId, agentId, old.grantId);
        db.delete(s.managedBindings)
          .where(eq(s.managedBindings.agentId, agentId))
          .run();
        return true;
      });
    },
    /** A revoked worker credential ends the binding it served. */
    forgetGrant(teamId: TeamId, agentId: AgentId, grantId: string) {
      return (
        db
          .delete(s.managedBindings)
          .where(
            and(
              eq(s.managedBindings.agentId, agentId),
              eq(s.managedBindings.teamId, teamId),
              eq(s.managedBindings.grantId, grantId),
            ),
          )
          .run().changes === 1
      );
    },
    /** Record that an agent's credential reached Team MCP. Evidence only. */
    seenByTeamMcp(p: Principal) {
      if (p.kind !== 'agent') return;
      const now = Date.now();
      db.insert(s.teamMcpPresence)
        .values({ agentId: p.agentId, teamId: p.teamId, lastSeenAt: now })
        .onConflictDoUpdate({
          target: s.teamMcpPresence.agentId,
          set: { lastSeenAt: now },
          setWhere: sql`${s.teamMcpPresence.lastSeenAt} < ${now - PRESENCE_MS}`,
        })
        .run();
    },
    teamMcpPresence(teamId: TeamId) {
      return db
        .select({
          agentId: s.teamMcpPresence.agentId,
          lastSeenAt: s.teamMcpPresence.lastSeenAt,
        })
        .from(s.teamMcpPresence)
        .where(eq(s.teamMcpPresence.teamId, teamId))
        .all();
    },
  };
}
