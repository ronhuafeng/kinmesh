import { z } from 'zod';
import { AgentId } from '../domain/contracts.js';
import { Revision, WorkspaceQuery } from './contracts.js';

/**
 * Hub state a view shows. Each is read by exactly one route, whose response
 * carries its `revision`:
 * - `workspace`: `GET /api/workspace?{place}`
 * - `t3`: `GET /api/teams/:teamId/t3`
 * - `runs`: `GET /api/agui/:teamId/:agentId`
 */
export const Resource = z.enum(['workspace', 't3', 'runs']);
export type Resource = z.infer<typeof Resource>;

/** A page open on top of the place, which shows more than the workspace. */
export const PageRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent'), id: AgentId }),
]);
export type PageRef = z.infer<typeof PageRef>;
/** The resources each page adds to the workspace. */
const PAGE_RESOURCES = {
  agent: ['t3', 'runs'],
} as const satisfies Record<PageRef['kind'], readonly Resource[]>;

/** What one stream watches: the place on screen, and the page open on it. */
export const Watch = WorkspaceQuery.extend({ page: PageRef.optional() });
export type Watch = z.infer<typeof Watch>;
export function watched(watch: Watch): Resource[] {
  return ['workspace', ...(watch.page ? PAGE_RESOURCES[watch.page.kind] : [])];
}

/** A page in a query string: `kind:id`. */
export const pageParam = (page: PageRef) => `${page.kind}:${page.id}`;
/** `GET /api/events` query: a watch, with its page as `kind:id`. */
export const WatchQuery = WorkspaceQuery.extend({
  page: z
    .string()
    .max(80)
    .transform((value) => {
      const at = value.indexOf(':');
      return { kind: value.slice(0, at), id: value.slice(at + 1) };
    })
    .pipe(PageRef)
    .optional(),
});

/**
 * The stream's only event, `revisions`. The first, sent when the stream
 * opens, names every watched resource; each later one names only those that
 * changed. A view reads again exactly the resources whose revision differs
 * from the one it holds.
 */
export const Revisions = z
  .strictObject({
    workspace: Revision.optional(),
    t3: Revision.optional(),
    runs: Revision.optional(),
  })
  .refine((revisions) => Object.keys(revisions).length > 0);
export type Revisions = z.infer<typeof Revisions>;
