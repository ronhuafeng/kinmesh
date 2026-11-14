import type { Database } from './database.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, asc, desc } from 'drizzle-orm';
import { z } from 'zod';
import * as s from './schema.js';
import { referenceKey, transactional } from './transactional.js';
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
import { principalAuthor as author } from '../domain/tasks.js';

function parseJson(value: string): unknown {
  return JSON.parse(value);
}
const now = () => new Date().toISOString();
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** An avatar is a small raster image; SVG and anything else is refused. */
export const AVATAR_LIMIT = 128 * 1024;
function avatarType(bytes: Buffer) {
  const starts = (...b: number[]) => b.every((v, i) => bytes[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}
export function agentRepository(d: Database) {
  const { q, atomic } = transactional(d);
  async function profile(teamId: TeamId, agentId: AgentId) {
    const row = (
      await q()
        .select(s.agentFields)
        .from(s.agents)
        .where(and(eq(s.agents.id, agentId), eq(s.agents.teamId, teamId)))
        .limit(1)
    )[0];
    if (row === undefined) throw new IdentityError(404);
    return Agent.parse({
      ...row,
      capabilities: parseJson(row.capabilities),
      preferences: parseJson(row.preferences),
    });
  }
  async function checkedGrant(p: Extract<Principal, { kind: 'agent' }>) {
    const grant = (
      await q()
        .select()
        .from(s.agentGrants)
        .where(eq(s.agentGrants.id, p.grantId))
        .limit(1)
    )[0];
    if (
      grant?.agentId !== p.agentId ||
      grant.teamId !== p.teamId ||
      grant.revokedAt !== null ||
      grant.expiresAt <= now()
    )
      throw new IdentityError(401);
    const agent = await profile(p.teamId, p.agentId);
    if (agent.lifecycle !== 'active') throw new IdentityError(401);
    return { grant, scopes: z.array(Scope).parse(parseJson(grant.scopes)) };
  }
  /**
   * Membership of the team, holding every scope given (agents) — 401 for an
   * unknown human or a dead grant, 403 otherwise.
   */
  async function teamAccess(p: Principal, teamId: TeamId, ...scopes: Scope[]) {
    Principal.parse(p);
    TeamId.parse(teamId);
    if (p.kind === 'agent') {
      const current = await checkedGrant(p);
      if (
        p.teamId !== teamId ||
        !scopes.every((scope) => current.scopes.includes(scope))
      )
        throw new IdentityError(403);
      return { role: 'agent' as const };
    }
    // Only whether they exist: nothing else about a person is needed here.
    const human = (
      await q()
        .select({ id: s.humans.id })
        .from(s.humans)
        .where(eq(s.humans.id, p.humanId))
        .limit(1)
    )[0];
    if (human === undefined) throw new IdentityError(401);
    const membership = (
      await q()
        .select()
        .from(s.memberships)
        .where(
          and(
            eq(s.memberships.humanId, p.humanId),
            eq(s.memberships.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (membership === undefined) throw new IdentityError(403);
  }
  /**
   * A person of the team: any member, since everyone is equal; an agent is
   * refused.
   */
  async function person(p: Principal, teamId: TeamId) {
    await teamAccess(p, teamId);
    if (p.kind !== 'human') throw new IdentityError(403);
  }
  async function access(
    p: Principal,
    teamId: TeamId,
    agentId: AgentId,
    scope: Scope,
  ) {
    Principal.parse(p);
    TeamId.parse(teamId);
    AgentId.parse(agentId);
    if (p.kind === 'human') await person(p, teamId);
    else {
      const current = await checkedGrant(p);
      if (
        p.teamId !== teamId ||
        p.agentId !== agentId ||
        !current.scopes.includes(scope)
      )
        throw new IdentityError(403);
    }
    return profile(teamId, agentId);
  }
  /** A person of the team, or the agent acting on its own profile. */
  async function self(p: Principal, teamId: TeamId, agentId: AgentId) {
    Principal.parse(p);
    TeamId.parse(teamId);
    AgentId.parse(agentId);
    if (p.kind === 'human') await person(p, teamId);
    else {
      await checkedGrant(p);
      if (p.teamId !== teamId || p.agentId !== agentId)
        throw new IdentityError(403);
    }
    return profile(teamId, agentId);
  }
  async function audit(
    p: Principal,
    teamId: TeamId,
    agentId: AgentId,
    kind: z.infer<typeof AuditEvent>['kind'],
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
    await q()
      .insert(s.agentAudit)
      .values({
        ...event,
        author: JSON.stringify(event.author),
        detail: JSON.stringify(event.detail),
      });
  }

  async function issue(
    p: Principal,
    teamId: TeamId,
    agentId: AgentId,
    input: GrantInput,
  ) {
    await person(p, teamId);
    if (
      p.kind !== 'human' ||
      (await profile(teamId, agentId)).lifecycle !== 'active'
    )
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
    await q()
      .insert(s.agentGrants)
      .values({
        ...grant,
        tokenHash: digest(token),
        scopes: JSON.stringify(data.scopes),
        issuedBy: p.humanId,
      });
    await audit(p, teamId, agentId, 'credential-issued', { grantId: grant.id });
    return { grant: Grant.parse(grant), token };
  }
  async function grantFor(teamId: TeamId, agentId: AgentId, grantId: string) {
    z.uuid().parse(grantId);
    const row = (
      await q()
        .select()
        .from(s.agentGrants)
        .where(
          and(
            eq(s.agentGrants.id, grantId),
            eq(s.agentGrants.agentId, agentId),
            eq(s.agentGrants.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) throw new IdentityError(404);
    return row;
  }
  async function revoke(
    p: Principal,
    teamId: TeamId,
    agentId: AgentId,
    grantId: string,
  ) {
    await person(p, teamId);
    await profile(teamId, agentId);
    await grantFor(teamId, agentId, grantId);
    await q()
      .update(s.agentGrants)
      .set({ revokedAt: now() })
      .where(
        and(eq(s.agentGrants.id, grantId), isNull(s.agentGrants.revokedAt)),
      );
    await audit(p, teamId, agentId, 'credential-revoked', { grantId });
  }
  async function correlation(teamId: TeamId, agentId: AgentId, id: string) {
    z.uuid().parse(id);
    const row = (
      await q()
        .select(s.correlationFields)
        .from(s.agentCorrelations)
        .where(
          and(
            eq(s.agentCorrelations.id, id),
            eq(s.agentCorrelations.teamId, teamId),
            eq(s.agentCorrelations.agentId, agentId),
          ),
        )
        .limit(1)
    )[0];
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
    async resolveToken(token: string): Promise<Principal> {
      if (!/^kma_[A-Za-z0-9_-]{43}$/.test(token)) throw new IdentityError(401);
      const row = (
        await q()
          .select()
          .from(s.agentGrants)
          .where(eq(s.agentGrants.tokenHash, digest(token)))
          .limit(1)
      )[0];
      if (row === undefined) throw new IdentityError(401);
      const principal = Principal.parse({
        kind: 'agent',
        agentId: row.agentId,
        teamId: row.teamId,
        grantId: row.id,
        scopes: parseJson(row.scopes),
      });
      if (principal.kind !== 'agent') throw new IdentityError(401);
      await checkedGrant(principal);
      return principal;
    },
    authorize: access,
    teamAccess,
    person,
    create(p: Principal, teamId: TeamId, input: ProfileInput) {
      return atomic(async () => {
        await person(p, teamId);
        const data = ProfileInput.parse(input);
        const agent = Agent.parse({
          ...data,
          id: randomUUID(),
          teamId,
          lifecycle: 'active',
          createdAt: now(),
          updatedAt: now(),
        });
        await q()
          .insert(s.agents)
          .values({
            ...agent,
            capabilities: JSON.stringify(agent.capabilities),
            preferences: JSON.stringify(agent.preferences),
          });
        await audit(p, teamId, agent.id, 'created', agent);
        return agent;
      });
    },
    get(p: Principal, teamId: TeamId, agentId: AgentId) {
      return access(p, teamId, agentId, 'agents:read');
    },
    async list(p: Principal, teamId: TeamId) {
      await person(p, teamId);
      const rows = await q()
        .select({ id: s.agents.id })
        .from(s.agents)
        .where(eq(s.agents.teamId, teamId))
        .orderBy(asc(s.agents.position));
      return Promise.all(rows.map((r) => profile(teamId, AgentId.parse(r.id))));
    },
    /** Bounded projection for people. Existing list/identity API contracts remain unchanged. */
    workspaceProfiles(p: Principal, teamId: TeamId) {
      return atomic(async () => {
        await person(p, teamId);
        const rows = await q()
          .select({ id: s.agents.id })
          .from(s.agents)
          .where(eq(s.agents.teamId, teamId))
          .orderBy(asc(s.agents.position))
          .limit(101);
        return {
          agents: await Promise.all(
            rows
              .slice(0, 100)
              .map((row) => profile(teamId, AgentId.parse(row.id))),
          ),
          truncated: rows.length > 100,
        };
      });
    },
    /** Append order is authoritative for persisted reports, even if wall-clock timestamps tie. */
    workspaceExecutions(p: Principal, teamId: TeamId, agentId: AgentId) {
      return atomic(async () => {
        const agent = await access(p, teamId, agentId, 'executions:read');
        const rows = await q()
          .select({ id: s.agentCorrelations.id })
          .from(s.agentCorrelations)
          .where(
            and(
              eq(s.agentCorrelations.agentId, agentId),
              eq(s.agentCorrelations.teamId, teamId),
            ),
          )
          .orderBy(desc(s.agentCorrelations.position))
          .limit(21);
        return {
          agent,
          executionsTruncated: rows.length > 20,
          executions: await Promise.all(
            rows.slice(0, 20).map(async (row) => {
              const events = await q()
                .select(s.runtimeEventFields)
                .from(s.agentRuntimeEvents)
                .where(eq(s.agentRuntimeEvents.correlationId, row.id))
                .orderBy(desc(s.agentRuntimeEvents.position))
                .limit(101);
              return {
                correlation: await correlation(teamId, agentId, row.id),
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
          ),
        };
      });
    },
    update(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      input: ProfileInput,
    ) {
      return atomic(async () => {
        await person(p, teamId);
        await profile(teamId, agentId);
        const data = ProfileInput.parse(input);
        await q()
          .update(s.agents)
          .set({
            ...data,
            capabilities: JSON.stringify(data.capabilities),
            preferences: JSON.stringify(data.preferences),
            updatedAt: now(),
          })
          .where(eq(s.agents.id, agentId));
        await audit(p, teamId, agentId, 'updated', data);
        return profile(teamId, agentId);
      });
    },
    /** Set an agent's picture: a person of the team, or the agent itself. */
    setAvatar(p: Principal, teamId: TeamId, agentId: AgentId, bytes: Buffer) {
      return atomic(async () => {
        await self(p, teamId, agentId);
        const mime = avatarType(bytes);
        if (mime === null || bytes.length > AVATAR_LIMIT)
          throw new IdentityError(400);
        const updatedAt = now();
        await q()
          .insert(s.agentAvatars)
          .values({ agentId, teamId, mime, bytes, updatedAt })
          .onConflictDoUpdate({
            target: s.agentAvatars.agentId,
            set: { mime, bytes, updatedAt },
          });
        await audit(p, teamId, agentId, 'avatar-set', {
          mime,
          size: bytes.length,
        });
        return { updatedAt };
      });
    },
    async removeAvatar(p: Principal, teamId: TeamId, agentId: AgentId) {
      await atomic(async () => {
        await self(p, teamId, agentId);
        await q()
          .delete(s.agentAvatars)
          .where(
            and(
              eq(s.agentAvatars.agentId, agentId),
              eq(s.agentAvatars.teamId, teamId),
            ),
          );
        await audit(p, teamId, agentId, 'avatar-removed', {});
      });
    },
    async avatar(p: Principal, teamId: TeamId, agentId: AgentId) {
      await access(p, teamId, agentId, 'agents:read');
      const row = (
        await q()
          .select({ mime: s.agentAvatars.mime, bytes: s.agentAvatars.bytes })
          .from(s.agentAvatars)
          .where(
            and(
              eq(s.agentAvatars.agentId, agentId),
              eq(s.agentAvatars.teamId, teamId),
            ),
          )
          .limit(1)
      )[0];
      return row ?? null;
    },
    /** Which agents have a picture, and since when; no image bytes. */
    async avatars(p: Principal, teamId: TeamId) {
      await person(p, teamId);
      return await q()
        .select({
          agentId: s.agentAvatars.agentId,
          updatedAt: s.agentAvatars.updatedAt,
        })
        .from(s.agentAvatars)
        .where(eq(s.agentAvatars.teamId, teamId));
    },
    lifecycle(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      lifecycle: 'active' | 'disabled',
    ) {
      return atomic(async () => {
        await person(p, teamId);
        await profile(teamId, agentId);
        z.enum(['active', 'disabled']).parse(lifecycle);
        await q()
          .update(s.agents)
          .set({ lifecycle, updatedAt: now() })
          .where(eq(s.agents.id, agentId));
        if (lifecycle === 'disabled')
          await q()
            .update(s.agentGrants)
            .set({ revokedAt: now() })
            .where(
              and(
                eq(s.agentGrants.agentId, agentId),
                isNull(s.agentGrants.revokedAt),
              ),
            );
        await audit(p, teamId, agentId, lifecycle, {});
        return profile(teamId, agentId);
      });
    },
    issue(p: Principal, teamId: TeamId, agentId: AgentId, input: GrantInput) {
      return atomic(async () => issue(p, teamId, agentId, input));
    },
    async revoke(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      grantId: string,
    ) {
      await atomic(async () => {
        await revoke(p, teamId, agentId, grantId);
      });
    },
    rotate(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      grantId: string,
      input: GrantInput,
    ) {
      return atomic(async () => {
        await person(p, teamId);
        if ((await grantFor(teamId, agentId, grantId)).revokedAt !== null)
          throw new IdentityError(409);
        await revoke(p, teamId, agentId, grantId);
        return issue(p, teamId, agentId, input);
      });
    },
    async grants(p: Principal, teamId: TeamId, agentId: AgentId) {
      await person(p, teamId);
      await profile(teamId, agentId);
      return (
        await q()
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
      ).map((r) =>
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
      return atomic(async () => {
        const agent = await access(p, teamId, agentId, 'executions:write');
        if (agent.lifecycle !== 'active') throw new IdentityError(409);
        const data = CorrelationInput.parse(input);
        const id = randomUUID();
        const ref = data.reference;
        await q()
          .insert(s.agentCorrelations)
          .values({
            id,
            agentId,
            teamId,
            referenceKey: referenceKey(ref),
            reference: JSON.stringify(ref),
            providerSessionId: data.providerSessionId,
            invocationId: data.invocationId,
            author: JSON.stringify(author(p)),
            createdAt: now(),
          });
        await audit(p, teamId, agentId, 'execution-associated', {
          correlationId: id,
        });
        return correlation(teamId, agentId, id);
      });
    },
    /** Exact immutable association, restricted to a currently authorized person of the team. */
    async getCorrelation(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      id: string,
    ) {
      await person(p, teamId);
      await profile(teamId, AgentId.parse(agentId));
      return correlation(teamId, agentId, id);
    },
    async correlations(p: Principal, teamId: TeamId, agentId: AgentId) {
      await access(p, teamId, agentId, 'executions:read');
      const rows = await q()
        .select({ id: s.agentCorrelations.id })
        .from(s.agentCorrelations)
        .where(
          and(
            eq(s.agentCorrelations.agentId, agentId),
            eq(s.agentCorrelations.teamId, teamId),
          ),
        )
        .orderBy(asc(s.agentCorrelations.position));
      return Promise.all(rows.map((r) => correlation(teamId, agentId, r.id)));
    },
    runtimeEvent(
      p: Principal,
      teamId: TeamId,
      agentId: AgentId,
      id: string,
      state: z.infer<typeof RuntimeState>,
    ) {
      return atomic(async () => {
        const agent = await access(p, teamId, agentId, 'executions:write');
        if (agent.lifecycle !== 'active') throw new IdentityError(409);
        await correlation(teamId, agentId, id);
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
      await access(p, teamId, agentId, 'executions:read');
      await correlation(teamId, agentId, id);
      return (
        await q()
          .select(s.runtimeEventFields)
          .from(s.agentRuntimeEvents)
          .where(eq(s.agentRuntimeEvents.correlationId, id))
      ).map((r) => RuntimeEvent.parse({ ...r, author: parseJson(r.author) }));
    },
    async audit(p: Principal, teamId: TeamId, agentId: AgentId) {
      await person(p, teamId);
      await profile(teamId, agentId);
      return (
        await q()
          .select()
          .from(s.agentAudit)
          .where(
            and(
              eq(s.agentAudit.teamId, teamId),
              eq(s.agentAudit.agentId, agentId),
            ),
          )
      ).map((r) =>
        AuditEvent.parse({
          ...r,
          author: parseJson(r.author),
          detail: parseJson(r.detail),
        }),
      );
    },
  };
}
