import { managedRepository } from './managed.js';
import { inboxRepository } from './inbox.js';
import { taskRepository } from './tasks.js';
import { CommunicationFact } from '../domain/communication.js';
import { communicationRepository } from './communication.js';
import { max, asc } from 'drizzle-orm';
import { agentRepository } from './agents.js';
import { operationJournal } from './operations.js';
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
  const agentStore = agentRepository(db);
  const communicationStore = communicationRepository(db, agentStore);
  const tasks = taskRepository(db, agentStore, communicationStore);
  return {
    inbox: inboxRepository(db, agentStore, communicationStore, tasks),
    tasks,
    communication: communicationStore,
    operations: operationJournal(db),
    agents: agentStore,
    managed: managedRepository(db, agentStore),
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
          const position =
            (tx
              .select({ value: max(tables.channels.position) })
              .from(tables.channels)
              .get()?.value ?? 0) + 1;
          tx.insert(tables.channels)
            .values({ ...channel, position })
            .run();
          tx.insert(tables.channelParticipants)
            .values({
              channelId: channel.id,
              teamId: team.id,
              memberKey: `human:${human.id}`,
              humanId: human.id,
              agentId: null,
              state: 'joined',
            })
            .run();
          const event = CommunicationFact.parse({
            version: 1,
            id: randomUUID(),
            teamId: team.id,
            channelId: channel.id,
            createdAt: new Date().toISOString(),
            author: { kind: 'human', humanId: human.id },
            kind: 'channel.created',
            topicId: null,
            messageId: null,
            mentions: [],
            participant: null,
            participantState: null,
            sourceMessageId: null,
            sourceEventId: null,
            operationKey: 'bootstrap.general',
          });
          tx.insert(tables.communicationOutbox)
            .values({
              id: event.id,
              channelId: channel.id,
              fact: JSON.stringify(event),
            })
            .run();
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
