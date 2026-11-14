import { managedRepository } from './managed.js';
import { inboxRepository } from './inbox.js';
import { inboxViews } from './inbox-views.js';
import { taskRepository } from './tasks.js';
import { communicationRepository } from './communication.js';
import { asc } from 'drizzle-orm';
import { agentRepository } from './agents.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import { operationJournal } from './operations.js';
import { eq, and, gt, isNull, lte } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as tables from './schema.js';
import { openDatabase } from './database.js';
import {
  Human,
  HumanId,
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

const digest = (token: string) =>
  createHash('sha256').update(token).digest('base64url');
/**
 * The team's store on PostgreSQL. Every method answers asynchronously; writes
 * that belong together run in one serializable transaction.
 */
export async function openStore(url: string) {
  const d = await openDatabase(url);
  const { q, atomic } = d;
  const agentStore = agentRepository(d);
  const communicationStore = communicationRepository(d, agentStore);
  const tasks = taskRepository(d, agentStore, communicationStore);
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
      inbox: inboxRepository(d, agentStore, communicationStore, tasks),
      /** What the workspace shows a person about deliveries and workers. */
      inboxViews: inboxViews(d, agentStore, communicationStore),
      tasks,
      communication: communicationStore,
      operations: operationJournal(d),
      agents: agentStore,
      managed: managedRepository(d, agentStore),
      close: d.close,
      /**
       * The person a Feishu identity is. Their first sign-in makes them a
       * member; the very first one also makes the team and its #general. The
       * mailbox is kept up to date, and finds a person linked to it before
       * they ever signed in with Feishu.
       */
      signIn({ feishuId, email }: { feishuId: string; email: string }) {
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
              .set({ feishuId, email })
              .where(eq(tables.humans.id, known.id));
            return Human.parse(known);
          }
          const human = Human.parse({
            id: randomUUID(),
            username: await freeUsername(email),
          });
          await q()
            .insert(tables.humans)
            .values({ ...human, feishuId, email });
          const existing = (await q().select().from(tables.teams).limit(1))[0];
          if (existing !== undefined) {
            const team = Team.parse(existing);
            await q()
              .insert(tables.memberships)
              .values({ humanId: human.id, teamId: team.id });
            await communicationStore.welcome(human.id, team.id);
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
          await communicationStore.createChannel(
            { kind: 'human', humanId: human.id },
            team.id,
            { operationKey: 'bootstrap.general', name: 'general' },
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
            throw new IdentityError(409);
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
          if (changed !== 1) throw new IdentityError(404);
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
      /** Names the team a person belongs to: the organization, as Feishu calls it. */
      async renameTeam(id: HumanId, name: string) {
        const membership = await this.teamFor(id);
        if (membership === undefined) throw new IdentityError(403);
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
       * The people of a team, by name, and whether each is online now: for
       * anyone of the team.
       */
      people(p: Principal, teamId: TeamId, now: number) {
        return atomic(async () => {
          await agentStore.teamAccess(p, teamId);
          const online = new Set(await this.online(now));
          return (
            await q()
              .select({
                id: tables.humans.id,
                username: tables.humans.username,
              })
              .from(tables.humans)
              .innerJoin(
                tables.memberships,
                eq(tables.memberships.humanId, tables.humans.id),
              )
              .where(eq(tables.memberships.teamId, teamId))
              .orderBy(asc(tables.humans.username))
              .limit(100)
          ).map((row) => ({
            ...Human.parse(row),
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
            .select({ id: tables.humans.id, username: tables.humans.username })
            .from(tables.humans)
            .where(eq(tables.humans.id, id))
            .limit(1)
        )[0];
        return row === undefined ? undefined : Human.parse(row);
      },
      async teamFor(id: HumanId) {
        const membership = (
          await q()
            .select()
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
    };
  }
}
export type Store = Awaited<ReturnType<typeof openStore>>;
