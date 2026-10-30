import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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
} from '../domain/contracts.js';

export function openStore(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path);
  chmodSync(path, 0o600);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema: tables });
  try {
    migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle', import.meta.url),
      ),
    });
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return {
    close: () => {
      if (sqlite.open) sqlite.close();
    },
    isBootstrapped: () =>
      db.select().from(tables.bootstrap).get() !== undefined,
    bootstrap(username: string, passwordHash: string, teamName: string) {
      return db.transaction(
        (tx) => {
          // A unique singleton, claimed inside the same transaction, fences simultaneous first-run requests.
          tx.insert(tables.bootstrap)
            .values({ singleton: 1, completedAt: new Date().toISOString() })
            .run();
          const human = Human.parse({ id: randomUUID(), username });
          const team = Team.parse({ id: randomUUID(), name: teamName });
          const channel = Channel.parse({
            id: randomUUID(),
            teamId: team.id,
            name: 'general',
          });
          tx.insert(tables.humans)
            .values({ ...human, passwordHash })
            .run();
          tx.insert(tables.teams).values(team).run();
          tx.insert(tables.memberships)
            .values({ humanId: human.id, teamId: team.id, role: 'owner' })
            .run();
          tx.insert(tables.channels).values(channel).run();
          return { human, team, channel };
        },
        { behavior: 'immediate' },
      );
    },
    credentials(username: string) {
      const row = db
        .select()
        .from(tables.humans)
        .where(eq(tables.humans.username, username))
        .get();
      return row === undefined
        ? undefined
        : z.object({ id: HumanId, passwordHash: z.string().min(1) }).parse(row);
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
        .where(
          and(
            eq(tables.memberships.humanId, id),
            eq(tables.memberships.role, 'owner'),
          ),
        )
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
      const channels = z
        .array(Channel)
        .parse(
          db
            .select()
            .from(tables.channels)
            .where(eq(tables.channels.teamId, team.id))
            .all(),
        );
      return { team, channels, role: verified.role };
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
