import { managedRepository } from './managed.js';
import { inboxRepository } from './inbox.js';
import { taskRepository } from './tasks.js';
import { communicationRepository } from './communication.js';
import { asc } from 'drizzle-orm';
import { agentRepository } from './agents.js';
import { IdentityError } from '../domain/agents.js';
import { operationJournal } from './operations.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, and, gt, isNull, lte } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as tables from './schema.js';
import {
  Human,
  HumanId,
  Team,
  Channel,
  Membership,
  TeamName,
  LOGIN_STATE_MS,
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
  SESSION_TOUCH_MS,
} from '../domain/contracts.js';

const digest = (token: string) =>
  createHash('sha256').update(token).digest('base64url');
export function openStore(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path);
  chmodSync(path, 0o600);
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema: tables });
  try {
    // A migration that rebuilds a table drops it while others still refer to
    // it, which SQLite allows only with foreign keys off; they cannot be
    // switched off inside the migrations' transaction, so they are off around
    // it, and every reference is checked before anything runs.
    sqlite.pragma('foreign_keys = OFF');
    migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle', import.meta.url),
      ),
    });
    const broken = z.array(z.unknown()).parse(sqlite.pragma('foreign_key_check'));
    if (broken.length > 0)
      throw new Error('Migrated database has broken references');
    sqlite.pragma('foreign_keys = ON');
  } catch (error) {
    sqlite.close();
    throw error;
  }
  const agentStore = agentRepository(db);
  const communicationStore = communicationRepository(db, agentStore);
  const tasks = taskRepository(db, agentStore, communicationStore);
  const ownWrites = sqlite.prepare('select total_changes()').pluck();
  /** A mailbox's local part as a handle, numbered when already taken. */
  function freeUsername(email: string) {
    const local = email
      .slice(0, email.lastIndexOf('@'))
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+|-+$/g, '')
      .slice(0, 58);
    const base =
      local.length >= 3 ? local : `member${local ? `-${local}` : ''}`;
    for (let n = 1; ; n += 1) {
      const candidate = n === 1 ? base : `${base}-${String(n)}`;
      const taken = db
        .select({ id: tables.humans.id })
        .from(tables.humans)
        .where(eq(tables.humans.username, candidate))
        .get();
      if (taken === undefined) return candidate;
    }
  }
  return {
    /** Moves on every commit: another process's (data_version), or this one's. */
    writes: () =>
      `${String(sqlite.pragma('data_version', { simple: true }))}:${String(ownWrites.get())}`,
    inbox: inboxRepository(db, agentStore, communicationStore, tasks),
    tasks,
    communication: communicationStore,
    operations: operationJournal(db),
    agents: agentStore,
    managed: managedRepository(db, agentStore),
    close: () => {
      if (sqlite.open) sqlite.close();
    },
    /**
     * The person a Feishu identity is. Their first sign-in makes them a
     * member; the very first one also makes the team and its #general. The
     * mailbox is kept up to date, and finds a person linked to it before
     * they ever signed in with Feishu.
     */
    signIn({ feishuId, email }: { feishuId: string; email: string }) {
      return db.transaction(
        (tx) => {
          const person = {
            id: tables.humans.id,
            username: tables.humans.username,
          };
          const known =
            tx
              .select(person)
              .from(tables.humans)
              .where(eq(tables.humans.feishuId, feishuId))
              .get() ??
            tx
              .select(person)
              .from(tables.humans)
              .where(
                and(
                  eq(tables.humans.email, email),
                  isNull(tables.humans.feishuId),
                ),
              )
              .get();
          if (known !== undefined) {
            tx.update(tables.humans)
              .set({ feishuId, email })
              .where(eq(tables.humans.id, known.id))
              .run();
            return Human.parse(known);
          }
          const human = Human.parse({
            id: randomUUID(),
            username: freeUsername(email),
          });
          tx.insert(tables.humans)
            .values({ ...human, feishuId, email })
            .run();
          const existing = tx.select().from(tables.teams).get();
          if (existing !== undefined) {
            const team = Team.parse(existing);
            tx.insert(tables.memberships)
              .values({ humanId: human.id, teamId: team.id })
              .run();
            communicationStore.welcome(human.id, team.id);
            return human;
          }
          // A unique singleton fences two first sign-ins at once.
          tx.insert(tables.bootstrap)
            .values({ singleton: 1, completedAt: new Date().toISOString() })
            .run();
          const team = Team.parse({ id: randomUUID(), name: 'Team' });
          tx.insert(tables.teams).values(team).run();
          tx.insert(tables.memberships)
            .values({ humanId: human.id, teamId: team.id })
            .run();
          // The first channel, made the way every channel is (nested savepoint).
          communicationStore.createChannel(
            { kind: 'human', humanId: human.id },
            team.id,
            { operationKey: 'bootstrap.general', name: 'general' },
          );
          return human;
        },
        { behavior: 'immediate' },
      );
    },
    /**
     * Ties a person who predates Feishu sign-in to their mailbox, so their
     * first Feishu sign-in is them. Only someone who has never signed in
     * with Feishu, and only a mailbox nobody else holds.
     */
    linkMailbox(username: string, email: string) {
      db.transaction((tx) => {
        const taken = tx
          .select({ username: tables.humans.username })
          .from(tables.humans)
          .where(eq(tables.humans.email, email))
          .get();
        if (taken !== undefined && taken.username !== username)
          throw new IdentityError(409);
        const changed = tx
          .update(tables.humans)
          .set({ email })
          .where(
            and(
              eq(tables.humans.username, username),
              isNull(tables.humans.feishuId),
            ),
          )
          .run().changes;
        if (changed !== 1) throw new IdentityError(404);
      });
    },
    /**
     * Sign-ins under way. The state travels to Feishu and back; the database
     * keeps its digest, and it is good for one return within ten minutes.
     */
    logins: {
      begin(now: number) {
        const state = randomBytes(32).toString('base64url');
        db.delete(tables.loginStates)
          .where(lte(tables.loginStates.expiresAt, now))
          .run();
        db.insert(tables.loginStates)
          .values({ stateHash: digest(state), expiresAt: now + LOGIN_STATE_MS })
          .run();
        return state;
      },
      finish(state: unknown, now: number) {
        if (typeof state !== 'string' || state === '') return false;
        return (
          db
            .delete(tables.loginStates)
            .where(
              and(
                eq(tables.loginStates.stateHash, digest(state)),
                gt(tables.loginStates.expiresAt, now),
              ),
            )
            .run().changes === 1
        );
      },
    },
    /**
     * Signed-in browsers. A session is a random token held only in the
     * encrypted cookie; the database keeps its digest.
     */
    sessions: {
      open(humanId: HumanId, now: number) {
        const token = randomBytes(32).toString('base64url');
        db.insert(tables.sessions)
          .values({
            tokenHash: digest(token),
            humanId,
            createdAt: now,
            lastSeenAt: now,
          })
          .run();
        return token;
      },
      /** The person a live session belongs to; undefined once it has ended. */
      resolve(token: unknown, now: number) {
        if (typeof token !== 'string' || token === '') return undefined;
        const row = db
          .select()
          .from(tables.sessions)
          .where(eq(tables.sessions.tokenHash, digest(token)))
          .get();
        if (row === undefined) return undefined;
        if (
          row.revokedAt !== null ||
          now - row.lastSeenAt > SESSION_IDLE_MS ||
          now - row.createdAt > SESSION_LIFETIME_MS
        )
          return undefined;
        if (now - row.lastSeenAt >= SESSION_TOUCH_MS)
          db.update(tables.sessions)
            .set({ lastSeenAt: now })
            .where(eq(tables.sessions.tokenHash, row.tokenHash))
            .run();
        return HumanId.parse(row.humanId);
      },
      revoke(token: unknown, now: number) {
        if (typeof token !== 'string' || token === '') return;
        db.update(tables.sessions)
          .set({ revokedAt: now })
          .where(eq(tables.sessions.tokenHash, digest(token)))
          .run();
      },
      /** Every session of one person, as on "Sign out everywhere". */
      revokeAll(humanId: HumanId, now: number) {
        db.update(tables.sessions)
          .set({ revokedAt: now })
          .where(
            and(
              eq(tables.sessions.humanId, humanId),
              isNull(tables.sessions.revokedAt),
            ),
          )
          .run();
      },
    },
    /** Names the team a person belongs to: the organization, as Feishu calls it. */
    renameTeam(id: HumanId, name: string) {
      const membership = this.teamFor(id);
      if (membership === undefined) throw new IdentityError(403);
      db.update(tables.teams)
        .set({ name: TeamName.parse(name) })
        .where(eq(tables.teams.id, membership.team.id))
        .run();
      return Team.parse({
        ...membership.team,
        name: TeamName.parse(name),
      });
    },
    human(id: HumanId) {
      const row = db
        .select({ id: tables.humans.id, username: tables.humans.username })
        .from(tables.humans)
        .where(eq(tables.humans.id, id))
        .get();
      return row === undefined ? undefined : Human.parse(row);
    },
    teamFor(id: HumanId) {
      const membership = db
        .select()
        .from(tables.memberships)
        .where(eq(tables.memberships.humanId, id))
        .get();
      if (membership === undefined) return undefined;
      const verified = Membership.parse(membership);
      const team = Team.parse(
        db
          .select()
          .from(tables.teams)
          .where(eq(tables.teams.id, verified.teamId))
          .get(),
      );
      const channels = z.array(Channel).parse(
        db
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
          .limit(100)
          .all(),
      );
      return { team, channels };
    },
    ready: () => {
      try {
        return sqlite.prepare('SELECT 1').get() !== undefined;
      } catch {
        return false;
      }
    },
  };
}
export type Store = ReturnType<typeof openStore>;
