import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentId, type TeamId } from '../domain/contracts.js';
import { IdentityError, type Principal } from '../domain/agents.js';
import type { Store } from '../persistence/store.js';
import { fingerprint } from '../persistence/transactional.js';
import type { Changes } from './changes.js';
import { resolvePrincipal } from './principals.js';
import { WorkspaceQuery } from './workspace.js';

type Owner = Extract<Principal, { kind: 'human' }>;
/** Open streams are bounded per person and for the whole hub. */
const PER_HUMAN = 8;
const TOTAL = 64;
/** A stream ends after this long; the browser reconnects with its session. */
const LIFETIME_MS = 10 * 60_000;
/** Keeps proxies from closing a quiet stream, and rechecks the session. */
const KEEPALIVE_MS = 25_000;
const RETRY_MS = 2000;

const Query = WorkspaceQuery.extend({
  /** The agent page on screen, whose runs are shown too. */
  agent: AgentId.optional(),
  /** The revision of the snapshot on screen. */
  since: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

/**
 * `GET /api/events`: one Server-Sent Events stream per open view. It sends
 * `changed`, and nothing else, whenever what that view shows has changed;
 * the browser then reads the view as usual. No data travels on the stream.
 */
export function registerEvents(
  app: FastifyInstance,
  store: Store,
  changes: Changes,
  views: {
    snapshot: (
      principal: Owner,
      query: WorkspaceQuery,
    ) => { revision: string; team: { id: TeamId } };
    signIn: (teamId: string) => string | null;
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
    const { agent, since, ...place } = Query.parse(request.query);
    const humanId = request.session.get('humanId');
    const credential = request.session.get('credential');
    const look = () => {
      const shown = views.snapshot(principal, place);
      let runs: unknown = null;
      if (agent)
        try {
          runs = store.agents.workspaceExecutions(
            principal,
            shown.team.id,
            agent,
          );
        } catch (error) {
          if (!(error instanceof IdentityError)) throw error;
        }
      return {
        workspace: shown.revision,
        rest: fingerprint([runs, views.signIn(shown.team.id)]),
      };
    };
    let seen = look();
    const mine = [...open.values()].filter((h) => h === principal.humanId);
    if (open.size >= TOTAL || mine.length >= PER_HUMAN)
      return reply.code(429).send({ error: 'Too many requests' });

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
    response.write(`retry: ${String(RETRY_MS)}\n\n`);
    const send = () => response.write('event: changed\ndata:\n\n');
    // The snapshot on screen may already be behind.
    if (since !== undefined && since !== seen.workspace) send();

    let pending = false;
    const check = () => {
      pending = false;
      if (!open.has(end)) return;
      try {
        // A changed password or lost membership ends the stream at once.
        resolvePrincipal(store, undefined, humanId, credential);
        const now = look();
        if (now.workspace === seen.workspace && now.rest === seen.rest) return;
        seen = now;
        send();
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
}
