import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import type { agentRepository } from './agents.js';
import type { t3ConnectionRepository } from './t3-connections.js';
import type { Database } from './database.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import type { GrantInput } from '../domain/agents.js';
import type { TeamId } from '../domain/contracts.js';
import { AgentId } from '../domain/contracts.js';

const Provider = z.string().trim().min(1).max(256);

/**
 * What the hub manages for its own worker: the team's T3 connection and the
 * agents it serves. Rows hold no secrets; tokens live in files.
 */
export function managedRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
  t3Connections: ReturnType<typeof t3ConnectionRepository>,
) {
  const { q, atomic } = d;
  /** A person of the team: T3 and the hub-held secrets are everyone's. */
  async function person(p: Principal, teamId: TeamId) {
    // Agents are refused before their grant is looked at.
    if (p.kind !== 'human') throw new DomainError('forbidden');
    await agents.person(p, teamId);
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
  /**
   * The hub keeps the credential of a worker it serves valid: a managed
   * grant nobody revoked, with less than two thirds of `lifetimeSeconds`
   * left (or already ended), ends `lifetimeSeconds` from now. It is renewed
   * in place, so the grant a run was frozen under stays the same grant and
   * the token in the hub's private file stays the worker's. A revoked grant
   * is never renewed, and one whose binding is gone ages out.
   */
  async function renew(lifetimeSeconds: number, agentId?: AgentId) {
    const now = Date.now();
    const lifetime = z.number().int().min(60).parse(lifetimeSeconds) * 1000;
    const renewed = await q()
      .update(s.agentGrants)
      .set({ expiresAt: new Date(now + lifetime).toISOString() })
      .where(
        and(
          isNull(s.agentGrants.revokedAt),
          lt(
            s.agentGrants.expiresAt,
            new Date(now + (lifetime * 2) / 3).toISOString(),
          ),
          inArray(s.agentGrants.id, [
            ...(await q()
              .select({
                worker: s.managedBindings.grantId,
                teamMcp: s.managedBindings.teamMcpGrantId,
              })
              .from(s.managedBindings)
              .where(
                agentId === undefined
                  ? undefined
                  : eq(s.managedBindings.agentId, agentId),
              )
              .then((rows) =>
                rows.flatMap((r) =>
                  r.teamMcp === null ? [r.worker] : [r.worker, r.teamMcp],
                ),
              )),
          ]),
        ),
      );
    return renewed.count;
  }
  return {
    /** Renews every worker credential the hub holds; returns how many. */
    renewWorkerGrants(lifetimeSeconds: number) {
      return atomic(() => renew(lifetimeSeconds));
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
        const t3 = await t3Connections.connection(p, teamId);
        if (t3 === null) throw new DomainError('conflict');
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
        // Connecting again keeps the credential the worker has, renewed if
        // it was running out; only a revoked one is replaced.
        if (old !== null) await renew(input.lifetimeSeconds, agentId);
        const live =
          old !== null &&
          (await agents.grants(p, teamId, agentId)).some(
            (g) =>
              g.id === old.grantId &&
              g.revokedAt === null &&
              g.expiresAt > new Date().toISOString(),
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
    /**
     * A new Team MCP credential for an agent the hub serves, to be written
     * into its Codex home; kept with `keepTeamMcp` once it is there.
     */
    issueTeamMcp(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      input: GrantInput,
    ) {
      return atomic(async () => {
        await person(p, teamId);
        if ((await binding(teamId, agentId)) === null)
          throw new DomainError('conflict');
        return agents.issue(p, teamId, agentId, input);
      });
    },
    /**
     * The credential now in the agent's Codex home: the hub renews it from
     * here on, and the one it replaces is revoked.
     */
    keepTeamMcp(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      grantId: string,
    ) {
      return atomic(async () => {
        await person(p, teamId);
        const old = await binding(teamId, agentId);
        if (old === null) throw new DomainError('conflict');
        await q()
          .update(s.managedBindings)
          .set({ teamMcpGrantId: grantId })
          .where(eq(s.managedBindings.agentId, agentId));
        if (old.teamMcpGrantId !== null && old.teamMcpGrantId !== grantId)
          await agents.revoke(p, teamId, agentId, old.teamMcpGrantId);
      });
    },
    /**
     * Stop serving the agent and revoke its worker credential, and the Team
     * MCP credential the hub wrote for it.
     */
    disconnect(p: Principal, teamId: TeamId, agentId: AgentId) {
      return atomic(async () => {
        await person(p, teamId);
        const old = await binding(teamId, agentId);
        if (old === null) return false;
        await agents.revoke(p, teamId, agentId, old.grantId);
        if (old.teamMcpGrantId !== null)
          await agents.revoke(p, teamId, agentId, old.teamMcpGrantId);
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
  };
}
