import { z } from 'zod';
import { Grant, type Scope } from '../../src/domain/agents.js';
import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';

export const ListedGrant = Grant.omit({ agentId: true, teamId: true });
export type ListedGrant = z.infer<typeof ListedGrant>;
export const Grants = z.object({
  grants: z.array(ListedGrant),
  revision: z.string(),
});
export const T3Status = z.object({
  connection: z
    .object({
      endpoint: z.string(),
      environmentId: z.string(),
      connectedAt: z.string(),
      access: z.enum(['operate', 'read']).nullable(),
      /** The mode the person chose in T3; null when unknown. */
      ceiling: z
        .enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])
        .nullable(),
      /** T3 no longer honours the sign-in. */
      expired: z.boolean(),
    })
    .nullable(),
  signIn: z.enum(['waiting', 'failed']).nullable(),
  /** The approval page of the sign-in you started, while it waits. */
  authorizationUrl: z.string().nullable().default(null),
  /** Approval returns to the person's own computer, whose address they paste. */
  pasteCallback: z.boolean(),
  /** The deployment connects T3; a person may still sign in to it. */
  provisioned: z.boolean(),
  /** A pairing code for this T3 can be had from the hub. */
  pairing: z.boolean().default(false),
  revision: z.string(),
});
export type T3Status = z.infer<typeof T3Status>;
export const Providers = z.object({
  providers: z.array(z.object({ id: z.string(), models: z.array(z.string()) })),
});
export type Step = 'done' | 'todo' | 'manual';
type T3Connection = NonNullable<T3Status['connection']>;
/** T3's names for the modes a person chooses on its approval page. */
export const MODE_NAMES = {
  'approval-required': '监督',
  'auto-accept-edits': '自动接受编辑',
  auto: '自动',
  'full-access': '完全访问',
} as const;
/** Where the team's T3 is, and how agents run there, when that is known. */
export function t3Where(connection: T3Connection) {
  return {
    host: new URL(connection.endpoint).host,
    access:
      connection.access === 'read'
        ? '只读'
        : connection.ceiling === null
          ? null
          : MODE_NAMES[connection.ceiling],
  };
}
/** The worker Kinmesh runs for this agent, if it runs one. */
export function managedOf(data: WorkspaceSnapshot, agentId: string) {
  return data.managed.find((m) => m.agentId === agentId) ?? null;
}

export function usable(grant: ListedGrant, scopes: Scope[]) {
  return (
    grant.revokedAt === null &&
    Date.parse(grant.expiresAt) > Date.now() &&
    scopes.every((s) => grant.scopes.includes(s))
  );
}
