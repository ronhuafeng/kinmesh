import type { FastifyInstance } from 'fastify';
import type { AgentId, TeamId } from '../domain/contracts.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import { fingerprint } from '../persistence/transactional.js';
import type { Store } from '../persistence/store.js';
import type { WorkspaceQuery } from '../workspace/contracts.js';
import {
  Revisions,
  WatchQuery,
  watched,
  type Resource,
} from '../workspace/events.js';
import type { Changes } from './changes.js';
import { resolvePrincipal } from './principals.js';

type Person = Extract<Principal, { kind: 'human' }>;
interface Revisioned {
  revision: string;
}
/** Open streams are bounded per person and for the whole hub. */
const PER_HUMAN = 8;
const TOTAL = 64;
/** A stream ends after this long; the browser reconnects with its session. */
const LIFETIME_MS = 10 * 60_000;
/** Keeps proxies from closing a quiet stream, and rechecks the session. */
const KEEPALIVE_MS = 25_000;
const RETRY_MS = 2000;
/** A resource the viewer can no longer read; reading it again shows why. */
const UNREADABLE = fingerprint('unreadable');

/**
 * `GET /api/events`: one Server-Sent Events stream per open view, whose only
 * event is `revisions` (see `src/workspace/events.ts`). No data travels on
 * the stream; the view reads what changed through its usual route.
 */
export function registerEvents(
  app: FastifyInstance,
  store: Store,
  changes: Changes,
  reads: {
    snapshot: (
      principal: Person,
      query: WorkspaceQuery,
    ) => Revisioned & { team: { id: TeamId } };
    t3Status: (principal: Principal, teamId: TeamId) => Revisioned;
    runs: (principal: Person, teamId: TeamId, agentId: AgentId) => Revisioned;
    grants: (
      principal: Principal,
      teamId: TeamId,
      agentId: AgentId,
    ) => Revisioned;
  },
) {
  const open = new Map<() => void, string>();
  app.addHook('preClose', (done) => {
    for (const end of [...open.keys()]) end();
    done();
  });
  app.get('/api/events', (request, reply) => {
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new IdentityError(403);
    const { page, ...place } = WatchQuery.parse(request.query);
    const resources = watched({ ...place, page });
    const session = request.session.get('session');
    const readable = (read: () => Revisioned) => {
      try {
        return read().revision;
      } catch (error) {
        if (error instanceof IdentityError) return UNREADABLE;
        throw error;
      }
    };
    /** The current revision of every watched resource. */
    const look = () => {
      const workspace = reads.snapshot(principal, place);
      const teamId = workspace.team.id;
      const now: Partial<Record<Resource, string>> = {};
      for (const resource of resources) {
        if (resource === 'workspace') now.workspace = workspace.revision;
        if (resource === 't3')
          now.t3 = readable(() => reads.t3Status(principal, teamId));
        // Both pages are about one agent: `page.id`.
        if (resource === 'runs' && page)
          now.runs = readable(() => reads.runs(principal, teamId, page.id));
        if (resource === 'grants' && page)
          now.grants = readable(() => reads.grants(principal, teamId, page.id));
      }
      return now;
    };
    let held = look();
    const mine = [...open.values()].filter((h) => h === principal.humanId);
    if (open.size >= TOTAL || mine.length >= PER_HUMAN)
      return reply.code(429).send({ error: 'Too many requests' });

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      // A proxy passes each event on at once instead of buffering them.
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
    response.write(`retry: ${String(RETRY_MS)}\n\n`);
    const send = (revisions: Partial<Record<Resource, string>>) =>
      response.write(
        `event: revisions\ndata: ${JSON.stringify(Revisions.parse(revisions))}\n\n`,
      );
    // The first event names everything watched, so a view that read before
    // the stream opened learns at once what it is behind on.
    send(held);

    let pending = false;
    const check = () => {
      pending = false;
      if (!open.has(end)) return;
      try {
        // A changed password or lost membership ends the stream at once.
        resolvePrincipal(store, undefined, session);
        const now = look();
        const changed: Partial<Record<Resource, string>> = {};
        for (const resource of resources) {
          const revision = now[resource];
          if (revision !== undefined && revision !== held[resource])
            changed[resource] = revision;
        }
        held = now;
        if (Object.keys(changed).length > 0) send(changed);
      } catch {
        end();
      }
    };
    const unsubscribe = changes.subscribe(() => {
      if (pending) return;
      pending = true;
      setImmediate(check);
    });
    const keepalive = setInterval(() => {
      response.write(': keepalive\n\n');
      check();
    }, KEEPALIVE_MS);
    const lifetime = setTimeout(end, LIFETIME_MS);
    function end() {
      if (!open.delete(end)) return;
      unsubscribe();
      clearInterval(keepalive);
      clearTimeout(lifetime);
      response.end();
    }
    open.set(end, principal.humanId);
    request.raw.on('close', end);
  });
  return { openStreams: () => open.size };
}
