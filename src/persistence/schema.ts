import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  check,
  uniqueIndex,
  foreignKey,
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

export const executionOperations = sqliteTable(
  'execution_operations',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    actor: text('actor').notNull(),
    operationKey: text('operation_key').notNull(),
    requestId: text('request_id').notNull().unique(),
    fingerprint: text('fingerprint').notNull(),
    tool: text('tool').notNull(),
    payload: text('payload').notNull(),
    phase: text('phase', {
      enum: ['prepared', 'dispatching', 'uncertain', 'known', 'rejected'],
    }).notNull(),
    reference: text('reference'),
    rejection: text('rejection'),
  },
  (t) => [
    uniqueIndex('execution_intent_scope').on(t.scope, t.actor, t.operationKey),
    check(
      'execution_phase',
      sql`${t.phase} IN ('prepared','dispatching','uncertain','known','rejected')`,
    ),
  ],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    name: text('name').notNull(),
    role: text('role').notNull(),
    capabilities: text('capabilities').notNull(),
    preferences: text('preferences').notNull(),
    memoryLocation: text('memory_location'),
    lifecycle: text('lifecycle').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('agent_team_identity').on(t.id, t.teamId),
    uniqueIndex('agent_team_name').on(t.teamId, t.name),
    check('agent_name_length', sql`length(trim(${t.name})) BETWEEN 1 AND 80`),
    check('agent_role', sql`${t.role} IN ('developer','reviewer','assistant')`),
    check('agent_lifecycle', sql`${t.lifecycle} IN ('active','disabled')`),
    check('agent_capabilities_json', sql`json_valid(${t.capabilities})`),
    check('agent_preferences_json', sql`json_valid(${t.preferences})`),
    check(
      'agent_memory_bound',
      sql`${t.memoryLocation} IS NULL OR length(${t.memoryLocation}) BETWEEN 1 AND 1024`,
    ),
  ],
);
export const agentGrants = sqliteTable(
  'agent_grants',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    teamId: text('team_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    label: text('label').notNull(),
    scopes: text('scopes').notNull(),
    issuedBy: text('issued_by')
      .notNull()
      .references(() => humans.id),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    foreignKey({
      columns: [t.agentId, t.teamId],
      foreignColumns: [agents.id, agents.teamId],
    }),
    check('grant_hash_length', sql`length(${t.tokenHash}) = 64`),
    check('grant_scopes_json', sql`json_valid(${t.scopes})`),
  ],
);
export const agentCorrelations = sqliteTable(
  'agent_correlations',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    teamId: text('team_id').notNull(),
    referenceKey: text('reference_key').notNull(),
    reference: text('reference').notNull(),
    providerSessionId: text('provider_session_id'),
    invocationId: text('invocation_id'),
    author: text('author').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.agentId, t.teamId],
      foreignColumns: [agents.id, agents.teamId],
    }),
    uniqueIndex('correlation_execution_owner').on(t.teamId, t.referenceKey),
    check('correlation_reference_json', sql`json_valid(${t.reference})`),
    check('correlation_author_json', sql`json_valid(${t.author})`),
  ],
);
export const agentAudit = sqliteTable(
  'agent_audit',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    teamId: text('team_id').notNull(),
    kind: text('kind').notNull(),
    author: text('author').notNull(),
    detail: text('detail').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.agentId, t.teamId],
      foreignColumns: [agents.id, agents.teamId],
    }),
    check(
      'audit_json',
      sql`json_valid(${t.author}) AND json_valid(${t.detail})`,
    ),
  ],
);
export const agentRuntimeEvents = sqliteTable(
  'agent_runtime_events',
  {
    id: text('id').primaryKey(),
    correlationId: text('correlation_id')
      .notNull()
      .references(() => agentCorrelations.id),
    state: text('state').notNull(),
    author: text('author').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check(
      'runtime_state',
      sql`${t.state} IN ('unknown','active','waiting','succeeded','failed','stopped')`,
    ),
  ],
);
