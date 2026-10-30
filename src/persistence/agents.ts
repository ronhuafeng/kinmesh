import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql, asc, desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import * as s from './schema.js';
import { AgentId, TeamId } from '../domain/contracts.js';
import {
  Agent,
  Grant,
  Correlation,
  RuntimeEvent,
  AuditEvent,
  ProfileInput,
  Principal,
  GrantInput,
  Scope,
  CorrelationInput,
  RuntimeEventInput,
  IdentityError,
  type RuntimeState,
} from '../domain/agents.js';

function parseJson(value: string): unknown {
  return JSON.parse(value);
}
const now = () => new Date().toISOString();
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function author(p: Principal) {
  return p.kind === 'human'
    ? { kind: p.kind, humanId: p.humanId }
    : { kind: p.kind, agentId: p.agentId, grantId: p.grantId };
}
export function agentRepository(db: BetterSQLite3Database<typeof s>) {
  function atomic<T>(action: () => T): T {
    try {
      return db.transaction(action, { behavior: 'immediate' });
    } catch (error) {
      const sqlite = z.object({ code: z.string() }).safeParse(error);
      if (sqlite.success && sqlite.data.code.startsWith('SQLITE_CONSTRAINT'))
        throw new IdentityError(409);
      throw error;
    }
  }
  function profile(teamId: TeamId, agentId: AgentId) {
    const row = db
      .select()
      .from(s.agents)
      .where(and(eq(s.agents.id, agentId), eq(s.agents.teamId, teamId)))
      .get();
    if (row === undefined) throw new IdentityError(404);
    return Agent.parse({
      ...row,
      capabilities: parseJson(row.capabilities),
      preferences: parseJson(row.preferences),
    });
  }
  function checkedGrant(p: Extract<Principal, { kind: 'agent' }>) {
    const grant = db
      .select()
      .from(s.agentGrants)
      .where(eq(s.agentGrants.id, p.grantId))
      .get();
    if (
      grant?.agentId !== p.agentId ||
      grant.teamId !== p.teamId ||
      grant.revokedAt !== null ||
      grant.expiresAt <= now()
    )
      throw new IdentityError(401);
    const agent = profile(p.teamId, p.agentId);
    if (agent.lifecycle !== 'active') throw new IdentityError(401);
    return { grant, scopes: z.array(Scope).parse(parseJson(grant.scopes)) };
  }
  function owner(p: Principal, teamId: TeamId) {
    Principal.parse(p);
    TeamId.parse(teamId);
    if (p.kind !== 'human') {
      checkedGrant(p);
      throw new IdentityError(403);
    }
    const membership = db
      .select()
      .from(s.memberships)
      .where(
        and(
          eq(s.memberships.humanId, p.humanId),
          eq(s.memberships.teamId, teamId),
        ),
      )
      .get();
    if (membership?.role !== 'owner') throw new IdentityError(403);
  }
  function access(
    p: Principal,
    teamId: TeamId,
    agentId: AgentId,
    scope: Scope,
  ) {
    Principal.parse(p);
    TeamId.parse(teamId);
    AgentId.parse(agentId);
    if (p.kind === 'human') owner(p, teamId);
    else {
      const current = checkedGrant(p);
      if (
        p.teamId !== teamId ||
        p.agentId !== agentId ||
        !current.scopes.includes(scope)
      )
        throw new IdentityError(403);
    }
    return profile(teamId, agentId);
  }
  function audit(
    p: Principal,
    teamId: TeamId,
    agentId: AgentId,
    kind: string,
    detail: unknown,
  ) {
    const event = AuditEvent.parse({
      id: randomUUID(),
      teamId,
      agentId,
      kind,
      author: author(p),
      detail,
      createdAt: now(),
    });
    db.insert(s.agentAudit)
      .values({
        ...event,
        author: JSON.stringify(event.author),
        detail: JSON.stringify(event.detail),
      })
      .run();
  }

  function issue(
    p: Principal,
    teamId: TeamId,
    agentId: AgentId,
    input: GrantInput,
  ) {
    owner(p, teamId);
    if (p.kind !== 'human' || profile(teamId, agentId).lifecycle !== 'active')
      throw new IdentityError(409);
    const data = GrantInput.parse(input);
    const token = 'kma_' + randomBytes(32).toString('base64url');
    const grant = {
      id: randomUUID(),
      agentId,
      teamId,
      label: data.label,
      scopes: data.scopes,
      createdAt: now(),
      expiresAt: new Date(
        Date.now() + data.lifetimeSeconds * 1000,
      ).toISOString(),
      revokedAt: null,
    };
    db.insert(s.agentGrants)
      .values({
        ...grant,
        tokenHash: digest(token),
        scopes: JSON.stringify(data.scopes),
        issuedBy: p.humanId,
      })
      .run();
    audit(p, teamId, agentId, 'credential-issued', { grantId: grant.id });
    return { grant: Grant.parse(grant), token };
  }
  function grantFor(teamId: TeamId, agentId: AgentId, grantId: string) {
    z.uuid().parse(grantId);
    const row = db
      .select()
      .from(s.agentGrants)
      .where(
        and(
          eq(s.agentGrants.id, grantId),
          eq(s.agentGrants.agentId, agentId),
          eq(s.agentGrants.teamId, teamId),
        ),
      )
      .get();
    if (row === undefined) throw new IdentityError(404);
    return row;
  }
  function revoke(
    p: Principal,
    teamId: TeamId,
    agentId: AgentId,
    grantId: string,
  ) {
    owner(p, teamId);
    profile(teamId, agentId);
    grantFor(teamId, agentId, grantId);
    db.update(s.agentGrants)
      .set({ revokedAt: now() })
      .where(
        and(eq(s.agentGrants.id, grantId), isNull(s.agentGrants.revokedAt)),
      )
      .run();
    audit(p, teamId, agentId, 'credential-revoked', { grantId });
  }
  function correlation(teamId: TeamId, agentId: AgentId, id: string) {
    z.uuid().parse(id);
    const row = db
      .select()
      .from(s.agentCorrelations)
      .where(
        and(
          eq(s.agentCorrelations.id, id),
          eq(s.agentCorrelations.teamId, teamId),
          eq(s.agentCorrelations.agentId, agentId),
        ),
      )
      .get();
    if (row === undefined) throw new IdentityError(404);
    return Correlation.parse({
      id: row.id,
      agentId: AgentId.parse(row.agentId),
      teamId: TeamId.parse(row.teamId),
      ...CorrelationInput.parse({
        reference: parseJson(row.reference),
        providerSessionId: row.providerSessionId,
        invocationId: row.invocationId,
      }),
      author: parseJson(row.author),
      createdAt: row.createdAt,
      acceptance: 'not-evaluated',
    });
  }
  return {
    resolveToken(token: string): Principal {
      if (!/^kma_[A-Za-z0-9_-]{43}$/.test(token)) throw new IdentityError(401);
      const row = db
        .select()
        .from(s.agentGrants)
        .where(eq(s.agentGrants.tokenHash, digest(token)))
        .get();
      if (row === undefined) throw new IdentityError(401);
      const principal = Principal.parse({
        kind: 'agent',
        agentId: row.agentId,
        teamId: row.teamId,
        grantId: row.id,
        scopes: parseJson(row.scopes),
      });
      if (principal.kind !== 'agent') throw new IdentityError(401);
      checkedGrant(principal);
      return principal;
    },
    authorize: access,
    teamAccess(p: Principal, teamId: TeamId, scope: Scope) {
      Principal.parse(p);
      TeamId.parse(teamId);
      if (p.kind === 'agent') {
        const current = checkedGrant(p);
        if (p.teamId !== teamId || !current.scopes.includes(scope))
          throw new IdentityError(403);
        return { role: 'agent' as const };
      }
      const human = db
        .select()
        .from(s.humans)
        .where(eq(s.humans.id, p.humanId))
        .get();
      if (human === undefined) throw new IdentityError(401);
      const membership = db
        .select()
        .from(s.memberships)
        .where(
          and(
            eq(s.memberships.humanId, p.humanId),
            eq(s.memberships.teamId, teamId),
          ),
        )
        .get();
      if (membership === undefined) throw new IdentityError(403);
      return { role: membership.role };
    },
    create(p: Principal, teamId: TeamId, input: ProfileInput) {
      return atomic(() => {
        owner(p, teamId);
        const data = ProfileInput.parse(input);
        const agent = Agent.parse({
          ...data,
          id: randomUUID(),
          teamId,
          lifecycle: 'active',
          createdAt: now(),
          updatedAt: now(),
        });
        db.insert(s.agents)
          .values({
            ...agent,
            capabilities: JSON.stringify(agent.capabilities),
            preferences: JSON.stringify(agent.preferences),
          })
          .run();
        audit(p, teamId, agent.id, 'created', agent);
        return agent;
      });
    },
    get(p: Principal, teamId: TeamId, agentId: AgentId) {
      return access(p, teamId, agentId, 'agents:read');
    },
    list(p: Principal, teamId: TeamId) {
      owner(p, teamId);
      return db
        .select({ id: s.agents.id })
        .from(s.agents)
        .where(eq(s.agents.teamId, teamId))
        .all()
        .map((r) => profile(teamId, AgentId.parse(r.id)));
    },
    /** Bounded owner projection. Existing list/identity API contracts remain unchanged. */
    workspaceProfiles(p: Principal, teamId: TeamId) {
      return atomic(() => {
        owner(p, teamId);
        const rows = db
          .select({ id: s.agents.id })
          .from(s.agents)
          .where(eq(s.agents.teamId, teamId))
          .orderBy(asc(sql`${s.agents}.rowid`))
          .limit(101)
          .all();
        return {
          agents: rows
            .slice(0, 100)
            .map((row) => profile(teamId, AgentId.parse(row.id))),
          truncated: rows.length > 100,
        };
      });
    },
    /** Append order is authoritative for persisted reports, even if wall-clock timestamps tie. */
    workspaceExecutions(p: Principal, teamId: TeamId, agentId: AgentId) {
      return atomic(() => {
        const agent = access(p, teamId, agentId, 'executions:read');
        const rows = db
          .select({ id: s.agentCorrelations.id })
          .from(s.agentCorrelations)
          .where(
            and(
              eq(s.agentCorrelations.agentId, agentId),
              eq(s.agentCorrelations.teamId, teamId),
            ),
          )
          .orderBy(desc(sql`${s.agentCorrelations}.rowid`))
          .limit(21)
          .all();
        return {
          agent,
          executionsTruncated: rows.length > 20,
          executions: rows.slice(0, 20).map((row) => {
            const events = db
              .select()
              .from(s.agentRuntimeEvents)
              .where(eq(s.agentRuntimeEvents.correlationId, row.id))
              .orderBy(desc(sql`${s.agentRuntimeEvents}.rowid`))
              .limit(101)
              .all();
            return {
              correlation: correlation(teamId, agentId, row.id),
              eventsTruncated: events.length > 100,
              events: events
                .slice(0, 100)
                .reverse()
                .map((event) =>
                  RuntimeEvent.parse({
                    ...event,
                    author: parseJson(event.author),
                  }),
                ),
            };
          }),
        };
      });
    },
    update(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      input: ProfileInput,
    ) {
      return atomic(() => {
        owner(p, teamId);
        profile(teamId, agentId);
        const data = ProfileInput.parse(input);
        db.update(s.agents)
          .set({
            ...data,
            capabilities: JSON.stringify(data.capabilities),
            preferences: JSON.stringify(data.preferences),
            updatedAt: now(),
          })
          .where(eq(s.agents.id, agentId))
          .run();
        audit(p, teamId, agentId, 'updated', data);
        return profile(teamId, agentId);
      });
    },
    lifecycle(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      lifecycle: 'active' | 'disabled',
    ) {
      return atomic(() => {
        owner(p, teamId);
        profile(teamId, agentId);
        z.enum(['active', 'disabled']).parse(lifecycle);
        db.update(s.agents)
          .set({ lifecycle, updatedAt: now() })
          .where(eq(s.agents.id, agentId))
          .run();
        if (lifecycle === 'disabled')
          db.update(s.agentGrants)
            .set({ revokedAt: now() })
            .where(
              and(
                eq(s.agentGrants.agentId, agentId),
                isNull(s.agentGrants.revokedAt),
              ),
            )
            .run();
        audit(p, teamId, agentId, lifecycle, {});
        return profile(teamId, agentId);
      });
    },
    issue(p: Principal, teamId: TeamId, agentId: AgentId, input: GrantInput) {
      return atomic(() => issue(p, teamId, agentId, input));
    },
    revoke(p: Principal, teamId: TeamId, agentId: AgentId, grantId: string) {
      atomic(() => {
        revoke(p, teamId, agentId, grantId);
      });
    },
    rotate(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      grantId: string,
      input: GrantInput,
    ) {
      return atomic(() => {
        owner(p, teamId);
        if (grantFor(teamId, agentId, grantId).revokedAt !== null)
          throw new IdentityError(409);
        revoke(p, teamId, agentId, grantId);
        return issue(p, teamId, agentId, input);
      });
    },
    grants(p: Principal, teamId: TeamId, agentId: AgentId) {
      owner(p, teamId);
      profile(teamId, agentId);
      return db
        .select({
          id: s.agentGrants.id,
          label: s.agentGrants.label,
          scopes: s.agentGrants.scopes,
          createdAt: s.agentGrants.createdAt,
          expiresAt: s.agentGrants.expiresAt,
          revokedAt: s.agentGrants.revokedAt,
        })
        .from(s.agentGrants)
        .where(
          and(
            eq(s.agentGrants.agentId, agentId),
            eq(s.agentGrants.teamId, teamId),
          ),
        )
        .all()
        .map((r) =>
          Grant.omit({ agentId: true, teamId: true }).parse({
            ...r,
            scopes: parseJson(r.scopes),
          }),
        );
    },
    correlate(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      input: CorrelationInput,
    ) {
      return atomic(() => {
        const agent = access(p, teamId, agentId, 'executions:write');
        if (agent.lifecycle !== 'active') throw new IdentityError(409);
        const data = CorrelationInput.parse(input);
        const id = randomUUID();
        const ref = data.reference;
        db.insert(s.agentCorrelations)
          .values({
            id,
            agentId,
            teamId,
            referenceKey: digest(
              JSON.stringify([
                ref.backend,
                ref.environmentId,
                ref.threadId,
                ref.runId ?? null,
              ]),
            ),
            reference: JSON.stringify(ref),
            providerSessionId: data.providerSessionId,
            invocationId: data.invocationId,
            author: JSON.stringify(author(p)),
            createdAt: now(),
          })
          .run();
        audit(p, teamId, agentId, 'execution-associated', {
          correlationId: id,
        });
        return correlation(teamId, agentId, id);
      });
    },
    /** Exact immutable association, restricted to a currently authorized human owner. */
    getCorrelation(p: Principal, teamId: TeamId, agentId: AgentId, id: string) {
      owner(p, teamId);
      access(p, teamId, agentId, 'executions:read');
      return correlation(teamId, agentId, id);
    },
    correlations(p: Principal, teamId: TeamId, agentId: AgentId) {
      access(p, teamId, agentId, 'executions:read');
      return db
        .select({ id: s.agentCorrelations.id })
        .from(s.agentCorrelations)
        .where(
          and(
            eq(s.agentCorrelations.agentId, agentId),
            eq(s.agentCorrelations.teamId, teamId),
          ),
        )
        .all()
        .map((r) => correlation(teamId, agentId, r.id));
    },
    runtimeEvent(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      id: string,
      state: z.infer<typeof RuntimeState>,
    ) {
      return atomic(() => {
        const agent = access(p, teamId, agentId, 'executions:write');
        if (agent.lifecycle !== 'active') throw new IdentityError(409);
        correlation(teamId, agentId, id);
        RuntimeEventInput.parse({ state });
        const event = {
          id: randomUUID(),
          correlationId: id,
          state,
          author: author(p),
          createdAt: now(),
        };
        db.insert(s.agentRuntimeEvents)
          .values({ ...event, author: JSON.stringify(event.author) })
          .run();
        return RuntimeEvent.parse(event);
      });
    },
    runtimeEvents(p: Principal, teamId: TeamId, agentId: AgentId, id: string) {
      access(p, teamId, agentId, 'executions:read');
      correlation(teamId, agentId, id);
      return db
        .select()
        .from(s.agentRuntimeEvents)
        .where(eq(s.agentRuntimeEvents.correlationId, id))
        .all()
        .map((r) => RuntimeEvent.parse({ ...r, author: parseJson(r.author) }));
    },
    audit(p: Principal, teamId: TeamId, agentId: AgentId) {
      owner(p, teamId);
      profile(teamId, agentId);
      return db
        .select()
        .from(s.agentAudit)
        .where(
          and(
            eq(s.agentAudit.teamId, teamId),
            eq(s.agentAudit.agentId, agentId),
          ),
        )
        .all()
        .map((r) =>
          AuditEvent.parse({
            ...r,
            author: parseJson(r.author),
            detail: parseJson(r.detail),
          }),
        );
    },
  };
}
