import { managedRepository } from './managed.js';
import { t3ConnectionRepository } from './t3-connections.js';
import { teamMcpPresenceRepository } from './team-mcp-presence.js';
import { spaceRepository } from './spaces.js';
import { inboxBindingRepository } from './inbox-bindings.js';
import { notificationRepository } from './notify.js';
import { quietRepository } from './quiet.js';
import { browserRepository } from './browsers.js';
import { inboxRepository } from './inbox.js';
import { inboxViews } from './inbox-views.js';
import { taskRepository } from './tasks.js';
import { channelAccess } from './channel-access.js';
import { factsOf } from './facts.js';
import { messageViews } from './message-views.js';
import { channelRepository } from './channels.js';
import { topicRepository } from './topics.js';
import { messageRepository } from './messages.js';
import { fileRepository } from './files.js';
import { reactionRepository } from './reactions.js';
import { pinRepository } from './pins.js';
import { asc } from 'drizzle-orm';
import { AVATAR_LIMIT, agentRepository, avatarType } from './agents.js';
import { agentEventRepository } from './agent-events.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
import { operationJournal } from './operations.js';
import { eq, and, gt, isNull, lte } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as tables from './schema.js';
import { digest, openDatabase } from './database.js';
import {
  Human,
  HumanId,
  Person,
  Team,
  Channel,
  Membership,
  TeamName,
  LOGIN_STATE_MS,
  PRESENCE_MS,
  type TeamId,
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
  SESSION_TOUCH_MS,
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
 * The team's store on PostgreSQL. Every method answers asynchronously; writes
 * that belong together run in one serializable transaction.
 */
export async function openStore(url: string) {
  const d = await openDatabase(url);
  const { q, atomic } = d;
  const agentStore = agentRepository(d);
  const agentEvents = agentEventRepository(d, agentStore);
  // What every channel's repositories share, made once so a read asks each
  // question once.
  const gate = channelAccess(d, agentStore);
  const facts = factsOf(d, agentStore);
  const views = messageViews(d);
  const channels = channelRepository(d, agentStore, gate, facts);
  const topics = topicRepository(d, gate, facts, views);
  const messages = messageRepository(d, agentStore, gate, facts, views);
  const tasks = taskRepository(d, agentStore, channels, topics, messages);
  const inbox = inboxRepository(
    d,
    agentStore,
    agentEvents,
    channels,
    topics,
    messages,
    tasks,
  );
  const t3Connections = t3ConnectionRepository(d, agentStore);
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
  return storeOf();
  function storeOf() {
    return {
      /** Calls `listener` after any change committed anywhere; returns how to stop. */
      listen: d.listen,
      /** Which database this is, to tell it from a replacement. */
      identity: d.identity,
      inbox,
      spaces: spaceRepository(d, inbox),
      inboxBindings: inboxBindingRepository(d),
      /** What the workspace shows a person about deliveries and workers. */
      inboxViews: inboxViews(d, agentStore, channels),
      tasks,
      channels,
      topics,
      messages,
      files: fileRepository(d, gate, facts, views),
      reactions: reactionRepository(d, gate, views),
      pins: pinRepository(d, gate, views),
      operations: operationJournal(d),
      agents: agentStore,
      agentEvents,
      managed: managedRepository(d, agentStore, t3Connections),
      t3Connections,
      teamMcpPresence: teamMcpPresenceRepository(d, agentStore),
      /** What notifies a person, their browsers, and what is sent to them. */
      notifications: notificationRepository(d),
      /** How each person set Kinmesh to reach them. */
      quiet: quietRepository(d),
      /** The browsers each person is notified in. */
      browsers: browserRepository(d),
      close: d.close,
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
       * Sign-ins under way. The state travels to Feishu and back; the database
       * keeps its digest, and it is good for one return within ten minutes.
       */
      logins: {
        async begin(now: number) {
          const state = randomBytes(32).toString('base64url');
          await q()
            .delete(tables.loginStates)
            .where(lte(tables.loginStates.expiresAt, now));
          await q()
            .insert(tables.loginStates)
            .values({
              stateHash: digest(state),
              expiresAt: now + LOGIN_STATE_MS,
            });
          return state;
        },
        async finish(state: unknown, now: number) {
          if (typeof state !== 'string' || state === '') return false;
          return (
            (
              await q()
                .delete(tables.loginStates)
                .where(
                  and(
                    eq(tables.loginStates.stateHash, digest(state)),
                    gt(tables.loginStates.expiresAt, now),
                  ),
                )
            ).count === 1
          );
        },
      },
      /**
       * Signed-in browsers. A session is a random token held only in the
       * encrypted cookie; the database keeps its digest.
       */
      sessions: {
        async open(humanId: HumanId, now: number) {
          const token = randomBytes(32).toString('base64url');
          await q()
            .insert(tables.sessions)
            .values({
              tokenHash: digest(token),
              humanId,
              createdAt: now,
              lastSeenAt: now,
            });
          return token;
        },
        /** The person a live session belongs to; undefined once it has ended. */
        async resolve(token: unknown, now: number) {
          if (typeof token !== 'string' || token === '') return undefined;
          const row = (
            await q()
              .select()
              .from(tables.sessions)
              .where(eq(tables.sessions.tokenHash, digest(token)))
              .limit(1)
          )[0];
          if (row === undefined) return undefined;
          if (
            row.revokedAt !== null ||
            now - row.lastSeenAt > SESSION_IDLE_MS ||
            now - row.createdAt > SESSION_LIFETIME_MS
          )
            return undefined;
          if (now - row.lastSeenAt >= SESSION_TOUCH_MS)
            await q()
              .update(tables.sessions)
              .set({ lastSeenAt: now })
              .where(eq(tables.sessions.tokenHash, row.tokenHash));
          return HumanId.parse(row.humanId);
        },
        async revoke(token: unknown, now: number) {
          if (typeof token !== 'string' || token === '') return;
          await q()
            .update(tables.sessions)
            .set({ revokedAt: now })
            .where(eq(tables.sessions.tokenHash, digest(token)));
        },
        /**
         * A person's sessions that still let them in, newest use first,
         * each named by a short id made from its stored hash (never the
         * token or the hash itself), and whether it is the one asking.
         */
        async list(humanId: HumanId, token: unknown, now: number) {
          const rows = await q()
            .select()
            .from(tables.sessions)
            .where(
              and(
                eq(tables.sessions.humanId, humanId),
                isNull(tables.sessions.revokedAt),
                gt(tables.sessions.lastSeenAt, now - SESSION_IDLE_MS),
                gt(tables.sessions.createdAt, now - SESSION_LIFETIME_MS),
              ),
            );
          const current =
            typeof token === 'string' && token !== '' ? digest(token) : null;
          return rows
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
            .map((row) => ({
              id: digest(row.tokenHash).slice(0, 16),
              current: row.tokenHash === current,
              createdAt: new Date(row.createdAt).toISOString(),
              lastSeenAt: new Date(row.lastSeenAt).toISOString(),
            }));
        },
        /** Ends one of a person's sessions, by the id `list` gave it. */
        async end(humanId: HumanId, id: string, now: number) {
          const rows = await q()
            .select({ tokenHash: tables.sessions.tokenHash })
            .from(tables.sessions)
            .where(
              and(
                eq(tables.sessions.humanId, humanId),
                isNull(tables.sessions.revokedAt),
              ),
            );
          const row = rows.find((r) => digest(r.tokenHash).slice(0, 16) === id);
          if (!row) return false;
          await q()
            .update(tables.sessions)
            .set({ revokedAt: now })
            .where(eq(tables.sessions.tokenHash, row.tokenHash));
          return true;
        },
        /** What a person's own page shows of them, from Feishu. */
        async profile(humanId: HumanId) {
          const row = (
            await q()
              .select({
                username: tables.humans.username,
                name: tables.humans.name,
                email: tables.humans.email,
              })
              .from(tables.humans)
              .where(eq(tables.humans.id, humanId))
              .limit(1)
          )[0];
          return row ?? null;
        },
        /** Every session of one person, as on "Sign out everywhere". */
        async revokeAll(humanId: HumanId, now: number) {
          await q()
            .update(tables.sessions)
            .set({ revokedAt: now })
            .where(
              and(
                eq(tables.sessions.humanId, humanId),
                isNull(tables.sessions.revokedAt),
              ),
            );
        },
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
          await agentStore.person(p, teamId);
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
          await agentStore.teamAccess(p, teamId);
          const online = new Set(await this.online(now));
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
      ready: d.ready,
      /** Runs reads as one consistent read (`openDatabase`). */
      read: d.read,
      /** How many transactions and queries some work began, for tests. */
      tally: d.tally,
    };
  }
}
export type Store = Awaited<ReturnType<typeof openStore>>;
