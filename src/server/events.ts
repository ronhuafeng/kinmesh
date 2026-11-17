import type { FastifyInstance } from 'fastify';
import type { AgentId, TeamId } from '../domain/contracts.js';
import type { Principal } from '../domain/agents.js';
import { DomainError } from '../domain/errors.js';
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
/** A snapshot as it travels: written out once, however many streams carry it. */
const written = new WeakMap<object, string>();
const writeOut = (snapshot: object) => {
  const text = written.get(snapshot) ?? JSON.stringify(snapshot);
  written.set(snapshot, text);
  return text;
};

/**
 * `GET /api/events`: one Server-Sent Events stream per open view (see
 * `src/workspace/events.ts`). `revisions` names what changed; the workspace
 * itself travels just before, as a `workspace` event, and the view reads the
 * rest through their routes.
 */
export function registerEvents(
  app: FastifyInstance,
  store: Store,
  changes: Changes,
  reads: {
    snapshot: (principal: Person, query: WorkspaceQuery) => Promise<Revisioned>;
    t3Status: (principal: Principal, teamId: TeamId) => Promise<Revisioned>;
    runs: (
      principal: Person,
      teamId: TeamId,
      agentId: AgentId,
    ) => Promise<Revisioned>;
    grants: (
      principal: Principal,
      teamId: TeamId,
      agentId: AgentId,
    ) => Promise<Revisioned>;
  },
) {
  const open = new Map<() => void, string>();
  app.addHook('preClose', (done) => {
    for (const end of [...open.keys()]) end();
    done();
  });
  app.get('/api/events', async (request, reply) => {
    const principal = request.principal;
    if (principal?.kind !== 'human') throw new DomainError('forbidden');
    const { page, ...place } = WatchQuery.parse(request.query);
    const resources = watched({ ...place, page });
    const session = request.session.get('session');
    const membership = await store.teamFor(principal.humanId);
    if (!membership) throw new DomainError('forbidden');
    const teamId = membership.team.id;
    const mine = [...open.values()].filter((h) => h === principal.humanId);
    if (open.size >= TOTAL || mine.length >= PER_HUMAN)
      return reply.code(429).send({ error: 'Too many requests' });
    /** What a read shows, or null once the viewer can no longer read it. */
    const readable = async (read: () => Promise<Revisioned>) => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof DomainError) return null;
        throw error;
      }
    };
    const revision = (read: Revisioned | null) => read?.revision ?? UNREADABLE;
    /**
     * Every watched resource as it is now: its revision, and the workspace
     * itself while it can be read.
     */
    const look = async () => {
      const now: Partial<Record<Resource, string>> = {};
      let workspace: Revisioned | null = null;
      for (const resource of resources) {
        if (resource === 'workspace') {
          workspace = await readable(() => reads.snapshot(principal, place));
          now.workspace = revision(workspace);
        }
        if (resource === 't3')
          now.t3 = revision(
            await readable(() => reads.t3Status(principal, teamId)),
          );
        // Both pages are about one agent: `page.id`.
        if (resource === 'runs' && page)
          now.runs = revision(
            await readable(() => reads.runs(principal, teamId, page.id)),
          );
        if (resource === 'grants' && page)
          now.grants = revision(
            await readable(() => reads.grants(principal, teamId, page.id)),
          );
      }
      return { now, workspace };
    };

    // The stream answers at once; what it watches is read after, so a slow
    // read never holds the connection unanswered.
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
    // Nothing is held yet, so the first check carries the workspace and
    // names everything else watched: a view that read before the stream
    // opened learns at once what it is behind on.
    let held: Partial<Record<Resource, string>> = {};

    let pending = false;
    const check = async () => {
      pending = false;
      if (!open.has(end)) return;
      try {
        // A changed password or lost membership ends the stream at once.
        await resolvePrincipal(store, undefined, session);
        const { now, workspace } = await look();
        const changed: Partial<Record<Resource, string>> = {};
        for (const resource of resources) {
          const revision = now[resource];
          if (revision !== undefined && revision !== held[resource])
            changed[resource] = revision;
        }
        held = now;
        // A workspace that can be read travels, just before the revisions
        // that name it; one that can't is only named, and reading it shows
        // why.
        if (changed.workspace !== undefined && workspace)
          response.write(`event: workspace\ndata: ${writeOut(workspace)}\n\n`);
        if (Object.keys(changed).length > 0) send(changed);
      } catch {
        end();
      }
    };
    // Checks run one after another, so revisions go out in the order read.
    let queue = Promise.resolve();
    const schedule = () => {
      if (pending) return;
      pending = true;
      queue = queue.then(check);
    };
    const unsubscribe = changes.subscribe(schedule);
    const keepalive = setInterval(() => {
      response.write(': keepalive\n\n');
      schedule();
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
    // Subscribed before the first read, so a change during it is not missed.
    schedule();
  });
  return { openStreams: () => open.size };
}
