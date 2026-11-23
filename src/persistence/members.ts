import type { Database } from './database.js';
import type { channelRepository } from './channels.js';
import { asc } from 'drizzle-orm';
import type { agentRepository } from './agents.js';
import { AVATAR_LIMIT, avatarType } from './agents.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as tables from './schema.js';
import type { HumanId } from '../domain/contracts.js';
import {
  Human,
  Person,
  Team,
  Channel,
  Membership,
  TeamName,
  PRESENCE_MS,
  type TeamId,
  SESSION_LIFETIME_MS,
} from '../domain/contracts.js';

/** What the workspace shows of a person, read with their picture's time. */
const personColumns = {
  id: tables.humans.id,
  username: tables.humans.username,
  name: tables.humans.name,
  avatar: tables.humanAvatars.updatedAt,
};
/** The handle stands in until Feishu has given a name. */
const personOf = (row: {
  id: string;
  username: string;
  name: string | null;
  avatar: string | null;
}) => Person.parse({ ...row, name: row.name ?? row.username });
/**
 * The people of the team and the team itself: signing in with Feishu (the
 * first person makes the team), their mailbox, picture and name, who is
 * online, and which team and channels a person has.
 */
export function memberRepository(
  d: Database,
  agents: ReturnType<typeof agentRepository>,
  channels: ReturnType<typeof channelRepository>,
) {
  const { q, atomic } = d;
  /** A mailbox's local part as a handle, numbered when already taken. */
  async function freeUsername(email: string) {
    const local = email
      .slice(0, email.lastIndexOf('@'))
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '')
      .slice(0, 58);
    const base =
      local.length >= 3 ? local : `member${local ? `-${local}` : ''}`;
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? base : `${base}-${String(n)}`;
      const [taken] = await q()
        .select({ id: tables.humans.id })
        .from(tables.humans)
        .where(eq(tables.humans.username, candidate))
        .limit(1);
      if (taken === undefined) return candidate;
    }
  }
  const members = {
    /**
     * The person a Feishu identity is. Their first sign-in makes them a
     * member; the very first one also makes the team and its #general. The
     * mailbox and name are kept up to date (a name Feishu doesn't give
     * leaves the one before), and the mailbox finds a person linked to it
     * before they ever signed in with Feishu.
     */
    signIn({
      feishuId,
      email,
      name = null,
    }: {
      feishuId: string;
      email: string;
      name?: string | null;
    }) {
      return atomic(async () => {
        const person = {
          id: tables.humans.id,
          username: tables.humans.username,
        };
        const known =
          (
            await q()
              .select(person)
              .from(tables.humans)
              .where(eq(tables.humans.feishuId, feishuId))
              .limit(1)
          )[0] ??
          (
            await q()
              .select(person)
              .from(tables.humans)
              .where(
                and(
                  eq(tables.humans.email, email),
                  isNull(tables.humans.feishuId),
                ),
              )
              .limit(1)
          )[0];
        if (known !== undefined) {
          await q()
            .update(tables.humans)
            .set({ feishuId, email, ...(name === null ? {} : { name }) })
            .where(eq(tables.humans.id, known.id));
          return Human.parse(known);
        }
        const human = Human.parse({
          id: randomUUID(),
          username: await freeUsername(email),
        });
        await q()
          .insert(tables.humans)
          .values({ ...human, feishuId, email, name });
        const existing = (await q().select().from(tables.teams).limit(1))[0];
        if (existing !== undefined) {
          const team = Team.parse(existing);
          await q()
            .insert(tables.memberships)
            .values({ humanId: human.id, teamId: team.id });
          await channels.welcome(human.id, team.id);
          return human;
        }
        // A unique singleton fences two first sign-ins at once.
        await q()
          .insert(tables.bootstrap)
          .values({ singleton: 1, completedAt: new Date().toISOString() });
        const team = Team.parse({ id: randomUUID(), name: 'Team' });
        await q().insert(tables.teams).values(team);
        await q()
          .insert(tables.memberships)
          .values({ humanId: human.id, teamId: team.id });
        // The first channel, made the way every channel is (nested savepoint).
        await channels.createChannel(
          { kind: 'human', humanId: human.id },
          team.id,
          {
            operationKey: 'bootstrap.general',
            name: 'general',
            visibility: 'public',
          },
        );
        return human;
      });
    },
    /**
     * Ties a person who predates Feishu sign-in to their mailbox, so their
     * first Feishu sign-in is them. Only someone who has never signed in
     * with Feishu, and only a mailbox nobody else holds.
     */
    async linkMailbox(username: string, email: string) {
      await atomic(async () => {
        const taken = (
          await q()
            .select({ username: tables.humans.username })
            .from(tables.humans)
            .where(eq(tables.humans.email, email))
            .limit(1)
        )[0];
        if (taken !== undefined && taken.username !== username)
          throw new DomainError('conflict');
        const changed = (
          await q()
            .update(tables.humans)
            .set({ email })
            .where(
              and(
                eq(tables.humans.username, username),
                isNull(tables.humans.feishuId),
              ),
            )
        ).count;
        if (changed !== 1) throw new DomainError('not-found');
      });
    },
    /**
     * Keeps a person's picture as Feishu gave it: a small PNG, JPEG or
     * WebP, like an agent's. The same picture again changes nothing.
     */
    async setPortrait(id: HumanId, bytes: Buffer) {
      const mime = avatarType(bytes);
      if (mime === null || bytes.length > AVATAR_LIMIT)
        throw new DomainError('invalid');
      await atomic(async () => {
        const kept = (
          await q()
            .select({ bytes: tables.humanAvatars.bytes })
            .from(tables.humanAvatars)
            .where(eq(tables.humanAvatars.humanId, id))
            .limit(1)
        )[0];
        if (kept?.bytes.equals(bytes)) return;
        const updatedAt = new Date().toISOString();
        await q()
          .insert(tables.humanAvatars)
          .values({ humanId: id, mime, bytes, updatedAt })
          .onConflictDoUpdate({
            target: tables.humanAvatars.humanId,
            set: { mime, bytes, updatedAt },
          });
      });
    },
    /** A person's picture, for anyone of their team; null when none. */
    portrait(p: Principal, teamId: TeamId, id: HumanId) {
      return atomic(async () => {
        await agents.person(p, teamId);
        const row = (
          await q()
            .select({
              mime: tables.humanAvatars.mime,
              bytes: tables.humanAvatars.bytes,
            })
            .from(tables.humanAvatars)
            .innerJoin(
              tables.memberships,
              eq(tables.memberships.humanId, tables.humanAvatars.humanId),
            )
            .where(
              and(
                eq(tables.humanAvatars.humanId, id),
                eq(tables.memberships.teamId, teamId),
              ),
            )
            .limit(1)
        )[0];
        return row ?? null;
      });
    },
    /** Names the team a person belongs to: the organization, as Feishu calls it. */
    async renameTeam(id: HumanId, name: string) {
      const membership = await this.teamFor(id);
      if (membership === undefined) throw new DomainError('forbidden');
      await q()
        .update(tables.teams)
        .set({ name: TeamName.parse(name) })
        .where(eq(tables.teams.id, membership.team.id));
      return Team.parse({
        ...membership.team,
        name: TeamName.parse(name),
      });
    },
    /**
     * The people of a team, by name and picture, and whether each is
     * online now: for anyone of the team.
     */
    people(p: Principal, teamId: TeamId, now: number) {
      return atomic(async () => {
        await agents.teamAccess(p, teamId);
        const online = new Set(await members.online(now));
        return (
          await q()
            .select(personColumns)
            .from(tables.humans)
            .innerJoin(
              tables.memberships,
              eq(tables.memberships.humanId, tables.humans.id),
            )
            .leftJoin(
              tables.humanAvatars,
              eq(tables.humanAvatars.humanId, tables.humans.id),
            )
            .where(eq(tables.memberships.teamId, teamId))
            .orderBy(asc(tables.humans.username))
            .limit(100)
        ).map((row) => ({
          ...personOf(row),
          online: online.has(row.id),
        }));
      });
    },
    /** Who has used a live session within the presence window. */
    async online(now: number) {
      return (
        await q()
          .selectDistinct({ id: tables.sessions.humanId })
          .from(tables.sessions)
          .where(
            and(
              isNull(tables.sessions.revokedAt),
              gt(tables.sessions.lastSeenAt, now - PRESENCE_MS),
              gt(tables.sessions.createdAt, now - SESSION_LIFETIME_MS),
            ),
          )
          .orderBy(asc(tables.sessions.humanId))
      ).map((row) => row.id);
    },
    async human(id: HumanId) {
      const row = (
        await q()
          .select(personColumns)
          .from(tables.humans)
          .leftJoin(
            tables.humanAvatars,
            eq(tables.humanAvatars.humanId, tables.humans.id),
          )
          .where(eq(tables.humans.id, id))
          .limit(1)
      )[0];
      return row === undefined ? undefined : personOf(row);
    },
    async teamFor(id: HumanId) {
      const membership = (
        await q()
          .select({
            humanId: tables.memberships.humanId,
            teamId: tables.memberships.teamId,
          })
          .from(tables.memberships)
          .where(eq(tables.memberships.humanId, id))
          .limit(1)
      )[0];
      if (membership === undefined) return undefined;
      const verified = Membership.parse(membership);
      const team = Team.parse(
        (
          await q()
            .select()
            .from(tables.teams)
            .where(eq(tables.teams.id, verified.teamId))
            .limit(1)
        )[0],
      );
      const channels = z.array(Channel).parse(
        await q()
          .select({
            id: tables.channels.id,
            teamId: tables.channels.teamId,
            name: tables.channels.name,
            visibility: tables.channels.visibility,
          })
          .from(tables.channels)
          .innerJoin(
            tables.channelParticipants,
            eq(tables.channels.id, tables.channelParticipants.channelId),
          )
          .where(
            and(
              eq(tables.channels.teamId, team.id),
              eq(tables.channelParticipants.memberKey, `human:${id}`),
              eq(tables.channelParticipants.state, 'joined'),
            ),
          )
          .orderBy(asc(tables.channels.position))
          .limit(100),
      );
      return { team, channels };
    },
  };
  return members;
}
