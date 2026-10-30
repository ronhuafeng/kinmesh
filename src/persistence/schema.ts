import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  check,
  uniqueIndex,
  foreignKey,
  index,
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
    position: integer('position').notNull().default(0),
  },
  (t) => [
    uniqueIndex('channel_position').on(t.position),
    uniqueIndex('channel_id_team').on(t.id, t.teamId),
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
    generation: integer('generation').notNull().default(0),
    claimToken: text('claim_token'),
    leaseUntil: integer('lease_until').notNull().default(0),
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

export const channelParticipants = sqliteTable(
  'channel_participants',
  {
    channelId: text('channel_id').notNull(),
    teamId: text('team_id').notNull(),
    memberKey: text('member_key').notNull(),
    humanId: text('human_id'),
    agentId: text('agent_id'),
    state: text('state').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.memberKey] }),
    foreignKey({
      columns: [t.channelId, t.teamId],
      foreignColumns: [channels.id, channels.teamId],
    }),
    foreignKey({
      columns: [t.humanId, t.teamId],
      foreignColumns: [memberships.humanId, memberships.teamId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.agentId, t.teamId],
      foreignColumns: [agents.id, agents.teamId],
    }),
    check(
      'participant_identity',
      sql`(${t.humanId} IS NOT NULL AND ${t.agentId} IS NULL AND ${t.memberKey} = 'human:' || ${t.humanId}) OR (${t.agentId} IS NOT NULL AND ${t.humanId} IS NULL AND ${t.memberKey} = 'agent:' || ${t.agentId})`,
    ),
    check('participant_state', sql`${t.state} IN ('joined','left','removed')`),
    index('participant_visibility').on(
      t.teamId,
      t.memberKey,
      t.state,
      t.channelId,
    ),
  ],
);
export const topics = sqliteTable(
  'topics',
  {
    position: integer('position').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    title: text('title').notNull(),
    author: text('author').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('topic_channel_identity').on(t.id, t.channelId),
    index('topic_timeline').on(t.channelId, t.position),
    check('topic_title_bound', sql`length(trim(${t.title})) BETWEEN 1 AND 160`),
  ],
);
export const messages = sqliteTable(
  'messages',
  {
    position: integer('position').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    topicId: text('topic_id'),
    author: text('author').notNull(),
    createdAt: text('created_at').notNull(),
    body: text('body').notNull(),
    sourceMessageId: text('source_message_id'),
    sourceEventId: text('source_event_id'),
  },
  (t) => [
    foreignKey({
      columns: [t.topicId, t.channelId],
      foreignColumns: [topics.id, topics.channelId],
    }),
    uniqueIndex('message_channel_identity').on(t.id, t.channelId),
    index('message_channel_timeline').on(t.channelId, t.position),
    index('message_topic_timeline').on(t.channelId, t.topicId, t.position),
    check('message_body_bound', sql`length(${t.body}) BETWEEN 1 AND 8000`),
  ],
);
export const messageMentions = sqliteTable(
  'message_mentions',
  {
    messageId: text('message_id').notNull(),
    channelId: text('channel_id').notNull(),
    memberKey: text('member_key').notNull(),
    target: text('target').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.memberKey] }),
    foreignKey({
      columns: [t.messageId, t.channelId],
      foreignColumns: [messages.id, messages.channelId],
    }),
    foreignKey({
      columns: [t.channelId, t.memberKey],
      foreignColumns: [
        channelParticipants.channelId,
        channelParticipants.memberKey,
      ],
    }),
  ],
);
export const communicationOutbox = sqliteTable(
  'communication_outbox',
  {
    position: integer('position').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    fact: text('fact').notNull(),
  },
  (t) => [
    index('outbox_channel_order').on(t.channelId, t.position),
    check('outbox_fact_json', sql`json_valid(${t.fact})`),
  ],
);
export const communicationOperations = sqliteTable(
  'communication_operations',
  {
    scope: text('scope').notNull(),
    operationKey: text('operation_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    result: text('result').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.operationKey] })],
);

export const tasks = sqliteTable(
  'tasks',
  {
    position: integer('position').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    teamId: text('team_id').notNull(),
    channelId: text('channel_id').notNull(),
    topicId: text('topic_id'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    criteria: text('criteria').notNull(),
    creator: text('creator').notNull(),
    acceptorHumanId: text('acceptor_human_id').notNull(),
    state: text('state').notNull(),
    status: text('status').notNull(),
    ownerKey: text('owner_key'),
    version: integer('version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.channelId, t.teamId],
      foreignColumns: [channels.id, channels.teamId],
    }),
    foreignKey({
      columns: [t.topicId, t.channelId],
      foreignColumns: [topics.id, topics.channelId],
    }),
    foreignKey({
      columns: [t.acceptorHumanId, t.teamId],
      foreignColumns: [memberships.humanId, memberships.teamId],
    }),
    uniqueIndex('task_channel_identity').on(t.id, t.channelId),
    index('task_channel_order').on(t.channelId, t.position),
    check('task_version_positive', sql`${t.version}>0`),
    check(
      'task_valid_state',
      sql`json_valid(${t.state}) AND json_extract(${t.state},'$.status') = ${t.status}`,
    ),
    check(
      'task_owner_state',
      sql`(${t.ownerKey} IS NULL AND json_extract(${t.state},'$.owner') IS NULL AND ${t.status} IN ('proposed','cancelled')) OR (${t.ownerKey} IS NOT NULL AND ${t.status} IN ('in-progress','review-requested','awaiting-human','rework-requested','accepted','cancelled') AND ${t.ownerKey} = json_extract(${t.state},'$.owner.kind') || ':' || json_extract(${t.state},'$.owner.id'))`,
    ),
  ],
);
export const taskEvents = sqliteTable(
  'task_events',
  {
    position: integer('position').primaryKey({ autoIncrement: true }),
    id: text('id')
      .notNull()
      .unique()
      .references(() => communicationOutbox.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    version: integer('version').notNull(),
    event: text('event').notNull(),
  },
  (t) => [
    uniqueIndex('task_revision_event').on(t.taskId, t.version),
    index('task_history_order').on(t.taskId, t.position),
    check('task_event_json', sql`json_valid(${t.event})`),
  ],
);
export const taskExecutions = sqliteTable(
  'task_executions',
  {
    position: integer('position').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    referenceKey: text('reference_key').notNull(),
    reference: text('reference').notNull(),
    author: text('author').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('task_execution_reference').on(t.taskId, t.referenceKey),
    index('task_execution_order').on(t.taskId, t.position),
  ],
);

export const inboxCauses = sqliteTable(
  'inbox_causes',
  {
    eventId: text('event_id')
      .primaryKey()
      .references(() => communicationOutbox.id),
    rootId: text('root_id')
      .notNull()
      .references(() => communicationOutbox.id),
    depth: integer('depth').notNull(),
  },
  (t) => [check('inbox_depth', sql`${t.depth} BETWEEN 0 AND 5`)],
);
export const agentInbox = sqliteTable(
  'agent_inbox',
  {
    position: integer('position').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    eventId: text('event_id')
      .notNull()
      .references(() => communicationOutbox.id),
    teamId: text('team_id').notNull(),
    channelId: text('channel_id').notNull(),
    agentId: text('agent_id').notNull(),
    rootId: text('root_id')
      .notNull()
      .references(() => communicationOutbox.id),
    depth: integer('depth').notNull(),
    taskId: text('task_id'),
    messageId: text('message_id'),
    topicId: text('topic_id'),
    state: text('state').notNull(),
    generation: integer('generation').notNull().default(0),
    claimToken: text('claim_token'),
    leaseUntil: integer('lease_until').notNull().default(0),
    nextAttempt: integer('next_attempt').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: integer('expires_at').notNull(),
    launch: text('launch'),
    operationId: text('operation_id'),
    reference: text('reference'),
    resultMessageId: text('result_message_id').references(() => messages.id),
    reason: text('reason').notNull().default('enqueued'),
  },
  (t) => [
    foreignKey({
      columns: [t.channelId, t.teamId],
      foreignColumns: [channels.id, channels.teamId],
    }),
    foreignKey({
      columns: [t.agentId, t.teamId],
      foreignColumns: [agents.id, agents.teamId],
    }),
    foreignKey({
      columns: [t.taskId, t.channelId],
      foreignColumns: [tasks.id, tasks.channelId],
    }),
    foreignKey({
      columns: [t.messageId, t.channelId],
      foreignColumns: [messages.id, messages.channelId],
    }),
    foreignKey({
      columns: [t.topicId, t.channelId],
      foreignColumns: [topics.id, topics.channelId],
    }),
    uniqueIndex('inbox_event_target').on(t.eventId, t.agentId),
    uniqueIndex('inbox_chain_target').on(t.rootId, t.agentId),
    index('inbox_due').on(t.state, t.nextAttempt, t.leaseUntil),
    index('inbox_agent_order').on(t.agentId, t.position),
    check(
      'inbox_state',
      sql`${t.state} IN ('ready','waiting','uncertain','acked','blocked','expired')`,
    ),
    check(
      'inbox_counters',
      sql`${t.generation} >= 0 AND ${t.attempts} >= 0 AND ${t.leaseUntil} >= 0 AND ${t.depth} BETWEEN 0 AND 4`,
    ),
    check(
      'inbox_claim',
      sql`(${t.claimToken} IS NULL AND ${t.leaseUntil}=0) OR (${t.claimToken} IS NOT NULL AND ${t.leaseUntil}>0)`,
    ),
    check(
      'inbox_ack',
      sql`(${t.state} = 'acked' AND ${t.resultMessageId} IS NOT NULL) OR (${t.state} != 'acked' AND ${t.resultMessageId} IS NULL)`,
    ),
  ],
);
export const inboxHistory = sqliteTable(
  'inbox_history',
  {
    position: integer('position').primaryKey({ autoIncrement: true }),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => agentInbox.id),
    generation: integer('generation').notNull(),
    state: text('state').notNull(),
    reason: text('reason').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('inbox_history_order').on(t.deliveryId, t.position)],
);
export const inboxResults = sqliteTable(
  'inbox_results',
  {
    deliveryId: text('delivery_id')
      .primaryKey()
      .references(() => agentInbox.id),
    messageId: text('message_id')
      .notNull()
      .unique()
      .references(() => messages.id),
    correlationId: text('correlation_id')
      .notNull()
      .references(() => agentCorrelations.id),
    taskLinkId: text('task_link_id').references(() => taskExecutions.id),
    result: text('result').notNull(),
  },
  (t) => [check('inbox_result_json', sql`json_valid(${t.result})`)],
);
