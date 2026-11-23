import { z } from 'zod';
import type { Scope } from '../../src/domain/agents.js';
import { ListedGrant } from '../shared/t3.js';

/** Scopes the Inbox worker needs (docs/collaboration.md, Grants and scopes). */
export const WORKER_SCOPES: Scope[] = [
  'channels:read',
  'channels:write',
  'tasks:read',
  'tasks:write',
  'tasks:review',
  'executions:read',
  'executions:write',
];
/** What the agent's provider uses to work with the team through Team MCP. */
export const TEAM_MCP_SCOPES: Scope[] = [
  'channels:read',
  'channels:write',
  'tasks:read',
  'tasks:write',
  'tasks:review',
];
export const LIFETIME_DAYS = 30;
export const Issued = z.object({
  grant: ListedGrant.loose(),
  token: z.string(),
});
