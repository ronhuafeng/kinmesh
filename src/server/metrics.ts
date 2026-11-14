import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { Store } from '../persistence/store.js';

/** A route as registered, never as requested: no IDs reach a label. */
const routeOf = (request: FastifyRequest) =>
  request.routeOptions.url ?? 'unmatched';

/**
 * The hub's own series, in one registry per hub. Labels are routes,
 * methods, statuses and states only: nothing a person wrote or is.
 */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'kinmesh_process_' });
  const requests = new Counter({
    name: 'kinmesh_http_requests_total',
    help: 'HTTP requests by route, method and status.',
    labelNames: ['route', 'method', 'status'],
    registers: [registry],
  });
  const latency = new Histogram({
    name: 'kinmesh_http_request_duration_seconds',
    help: 'HTTP request latency by route and method.',
    labelNames: ['route', 'method'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const rateLimited = new Counter({
    name: 'kinmesh_rate_limited_total',
    help: 'Requests refused for exceeding a rate limit, by route.',
    labelNames: ['route'],
    registers: [registry],
  });
  return {
    registry,
    /** For the rate limiter: a client went over a limit. */
    limited: (request: FastifyRequest) => {
      rateLimited.inc({ route: routeOf(request) });
    },
    /** Counts and times every response, and serves `/metrics`. */
    register(
      app: FastifyInstance,
      store: Store,
      token: string | null,
      live: { workerReady: () => boolean; openStreams: () => number },
    ) {
      app.addHook('onResponse', async (request, reply) => {
        const route = routeOf(request);
        requests.inc({
          route,
          method: request.method,
          status: String(reply.statusCode),
        });
        latency.observe(
          { route, method: request.method },
          reply.elapsedTime / 1000,
        );
      });
      new Gauge({
        name: 'kinmesh_deliveries',
        help: 'Inbox deliveries by state.',
        labelNames: ['state'],
        registers: [registry],
        async collect() {
          this.reset();
          for (const { state, count } of await store.inbox.countsByState())
            this.set({ state }, count);
        },
      });
      new Gauge({
        name: 'kinmesh_inbox_worker_up',
        help: '1 while the supervised Inbox worker is connected.',
        registers: [registry],
        collect() {
          this.set(live.workerReady() ? 1 : 0);
        },
      });
      new Gauge({
        name: 'kinmesh_agents_awake',
        help: 'Agents a worker can wake now.',
        registers: [registry],
        async collect() {
          this.set((await store.inbox.awake(Date.now())).length);
        },
      });
      new Gauge({
        name: 'kinmesh_event_streams',
        help: 'Open event streams.',
        registers: [registry],
        collect() {
          this.set(live.openStreams());
        },
      });
      const expected =
        token === null ? null : createHash('sha256').update(token).digest();
      // Only this machine, or whoever holds the metrics token.
      const allowed = (request: FastifyRequest) => {
        if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip))
          return true;
        const given = request.headers.authorization;
        if (expected === null || typeof given !== 'string') return false;
        const actual = createHash('sha256')
          .update(given.replace(/^Bearer /, ''))
          .digest();
        return given.startsWith('Bearer ') && timingSafeEqual(expected, actual);
      };
      app.get('/metrics', async (request, reply) => {
        if (!allowed(request))
          return reply.code(403).send({ error: 'Metrics are not public' });
        return reply
          .header('Cache-Control', 'no-store')
          .type(registry.contentType)
          .send(await registry.metrics());
      });
    },
  };
}
