import { z } from 'zod';
import { AgentId, HumanId, TeamId } from './contracts.js';
import { Reference } from './execution.js';

export const Scope = z.enum([
  'agents:read',
  'channels:read',
  'channels:write',
  'tasks:write',
  'executions:read',
  'executions:write',
]);
export type Scope = z.infer<typeof Scope>;
const BoundedId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\s\u0000-\u001f]+$/u);
export const Preferences = z
  .strictObject({
    environmentId: BoundedId.nullable(),
    providerId: BoundedId.nullable(),
    modelId: BoundedId.nullable(),
  })
  .refine((v) => v.modelId === null || v.providerId !== null);
export const ProfileInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  role: z.enum(['developer', 'reviewer', 'assistant']),
  capabilities: z
    .array(BoundedId)
    .max(32)
    .refine((v) => new Set(v).size === v.length),
  preferences: Preferences,
  memoryLocation: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .regex(/^[^\u0000-\u001f]+$/u)
    .nullable(),
});
export type ProfileInput = z.infer<typeof ProfileInput>;
export const Agent = ProfileInput.extend({
  id: AgentId,
  teamId: TeamId,
  lifecycle: z.enum(['active', 'disabled']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof Agent>;
export const GrantInput = z.strictObject({
  label: z.string().trim().min(1).max(80),
  scopes: z
    .array(Scope)
    .min(1)
    .max(6)
    .refine((v) => new Set(v).size === v.length),
  lifetimeSeconds: z
    .number()
    .int()
    .min(60)
    .max(90 * 86400),
});
export type GrantInput = z.infer<typeof GrantInput>;
export const Principal = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), humanId: HumanId }),
  z.strictObject({
    kind: z.literal('agent'),
    agentId: AgentId,
    teamId: TeamId,
    grantId: z.uuid(),
    scopes: z.array(Scope),
  }),
]);
export type Principal = z.infer<typeof Principal>;
export const CorrelationInput = z.strictObject({
  reference: Reference.extend({
    environmentId: BoundedId,
    threadId: BoundedId,
    runId: BoundedId.optional(),
  }),
  providerSessionId: BoundedId.nullable(),
  invocationId: BoundedId.nullable(),
});
export type CorrelationInput = z.infer<typeof CorrelationInput>;
export const RuntimeState = z.enum([
  'unknown',
  'active',
  'waiting',
  'succeeded',
  'failed',
  'stopped',
]);
export const RuntimeEventInput = z.strictObject({ state: RuntimeState });
export class IdentityError extends Error {
  constructor(readonly statusCode: 400 | 401 | 403 | 404 | 409) {
    super('Identity request rejected');
  }
}

export const Author = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('human'), humanId: HumanId }),
  z.strictObject({
    kind: z.literal('agent'),
    agentId: AgentId,
    grantId: z.uuid(),
  }),
]);
export const Grant = GrantInput.omit({ lifetimeSeconds: true }).extend({
  id: z.uuid(),
  agentId: AgentId,
  teamId: TeamId,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export const Correlation = CorrelationInput.extend({
  id: z.uuid(),
  agentId: AgentId,
  teamId: TeamId,
  author: Author,
  createdAt: z.iso.datetime(),
  acceptance: z.literal('not-evaluated'),
});
export const RuntimeEvent = z.strictObject({
  id: z.uuid(),
  correlationId: z.uuid(),
  state: RuntimeState,
  author: Author,
  createdAt: z.iso.datetime(),
});
const AuditBase = z.strictObject({
  id: z.uuid(),
  agentId: AgentId,
  teamId: TeamId,
  author: Author,
  createdAt: z.iso.datetime(),
});
export const AuditEvent = z.discriminatedUnion('kind', [
  AuditBase.extend({ kind: z.literal('created'), detail: Agent }),
  AuditBase.extend({ kind: z.literal('updated'), detail: ProfileInput }),
  AuditBase.extend({ kind: z.literal('active'), detail: z.strictObject({}) }),
  AuditBase.extend({ kind: z.literal('disabled'), detail: z.strictObject({}) }),
  AuditBase.extend({
    kind: z.literal('credential-issued'),
    detail: z.strictObject({ grantId: z.uuid() }),
  }),
  AuditBase.extend({
    kind: z.literal('credential-revoked'),
    detail: z.strictObject({ grantId: z.uuid() }),
  }),
  AuditBase.extend({
    kind: z.literal('execution-associated'),
    detail: z.strictObject({ correlationId: z.uuid() }),
  }),
]);
