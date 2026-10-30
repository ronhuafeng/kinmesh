import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  check,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const humans = sqliteTable(
  'humans',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
  },
  (t) => [
    check('username_length', sql`length(${t.username}) BETWEEN 3 AND 64`),
  ],
);
export const teams = sqliteTable(
  'teams',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
  },
  (t) => [
    check('team_name_length', sql`length(trim(${t.name})) BETWEEN 1 AND 80`),
  ],
);
export const memberships = sqliteTable(
  'memberships',
  {
    humanId: text('human_id')
      .notNull()
      .references(() => humans.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.humanId, t.teamId] }),
    check('valid_role', sql`${t.role} IN ('owner', 'member')`),
  ],
);
export const channels = sqliteTable(
  'channels',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
  },
  (t) => [
    uniqueIndex('channel_team_name').on(t.teamId, t.name),
    check('channel_name_length', sql`length(trim(${t.name})) BETWEEN 1 AND 80`),
  ],
);
export const bootstrap = sqliteTable(
  'bootstrap',
  {
    singleton: integer('singleton').primaryKey(),
    completedAt: text('completed_at').notNull(),
  },
  (t) => [check('one_bootstrap', sql`${t.singleton} = 1`)],
);
